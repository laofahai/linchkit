/**
 * REAL rule-in-action test: the manager-approval-threshold business rule.
 *
 * Exercises the genuine production path — the core ActionExecutor's
 * rule-evaluation step (`evaluateActionRules`, PRs #460-#475) — with the
 * capability's REAL action + rule + state-machine definitions. NO seam mocks:
 * the rule fires inside `approve_purchase_request` execution, reads the stored
 * `amount` and the acting actor's `groups`, and BLOCKS or ALLOWS accordingly.
 *
 * This is the object a future describe-to-exists NL loop edits to change the policy.
 *
 * Coverage:
 *   - amount <= threshold → a purchase_user can approve.
 *   - amount  > threshold → a purchase_user is BLOCKED by the rule.
 *   - amount  > threshold → a purchase_manager CAN approve.
 *   - the block surfaces the bilingual rule message + rule_block constraint.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { ActionResult, Actor } from "@linchkit/core";
import {
  createActionExecutor,
  createStateMachine,
  EntityRegistry,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { approveAction } from "../src/actions/approve";
import { flagForReviewAction } from "../src/actions/flag-for-review";
import { rejectAction } from "../src/actions/reject";
import { submitAction } from "../src/actions/submit";
import { purchaseRequestEntity } from "../src/entities/purchase-request";
import {
  MANAGER_APPROVAL_THRESHOLD,
  managerApprovalThresholdRule,
} from "../src/rules/manager-approval-threshold";
import { purchaseRequestState } from "../src/states/purchase-request";

// ── Actors ──────────────────────────────────────────────
// Deterministic roles — NOT the no-auth elevated actor, so the rule's
// manager check is meaningfully exercised in both directions.

const purchaseUser: Actor = {
  type: "human",
  id: "user-001",
  name: "Alice User",
  groups: ["purchase_user"],
};

const purchaseManager: Actor = {
  type: "human",
  id: "mgr-001",
  name: "Bob Manager",
  groups: ["purchase_manager"],
};

// ── Test harness: real executor wired with the real rule ────

function buildExecutor() {
  const store = new InMemoryStore();
  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseRequestEntity);

  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
    entityRegistry,
    stateMachine: createStateMachine(purchaseRequestState),
    // The capability's real business rules — the same array capability.ts
    // registers and assemble-schema.ts forwards to the runtime executor.
    rules: [managerApprovalThresholdRule],
  });

  for (const action of [submitAction, approveAction, rejectAction, flagForReviewAction]) {
    executor.registry.register(action);
  }

  return { store, executor };
}

/** Seed a pending purchase request directly in the store (skip the submit step). */
async function seedPending(
  store: InstanceType<typeof InMemoryStore>,
  amount: number,
): Promise<string> {
  const record = await store.create("purchase_request", {
    title: "Test request",
    amount,
    requester: "Alice User",
    requester_email: "alice@example.com",
    status: "pending",
  });
  return record.id as string;
}

// ── Tests ───────────────────────────────────────────────

describe("manager_approval_threshold rule — fires in approve_purchase_request", () => {
  let store: InstanceType<typeof InMemoryStore>;
  let executor: ReturnType<typeof createActionExecutor>;

  beforeEach(() => {
    ({ store, executor } = buildExecutor());
  });

  test(`amount <= ${MANAGER_APPROVAL_THRESHOLD}: a purchase_user CAN approve`, async () => {
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD - 1);

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(true);
    const updated = await store.get("purchase_request", id);
    expect(updated.status).toBe("approved");
    expect(updated.approved_by).toBe(purchaseUser.id);
  });

  test(`amount == ${MANAGER_APPROVAL_THRESHOLD} (boundary): a purchase_user CAN approve`, async () => {
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD);

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect((await store.get("purchase_request", id)).status).toBe("approved");
  });

  test(`amount > ${MANAGER_APPROVAL_THRESHOLD}: a purchase_user is BLOCKED by the rule`, async () => {
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD + 1);

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(false);
    // The write must NOT have happened — record stays pending.
    expect((await store.get("purchase_request", id)).status).toBe("pending");

    // The block carries the bilingual rule message + the rule_block constraint.
    const data = result.data as { error?: string; context?: { constraint?: string } };
    expect(String(data.error)).toContain(String(MANAGER_APPROVAL_THRESHOLD));
    expect(String(data.error)).toContain("manager approval");
    expect(data.context?.constraint).toBe("rule_block");
  });

  test(`amount > ${MANAGER_APPROVAL_THRESHOLD}: a purchase_manager CAN approve`, async () => {
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD + 5000);

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseManager,
    )) as ActionResult;

    expect(result.success).toBe(true);
    const updated = await store.get("purchase_request", id);
    expect(updated.status).toBe("approved");
    expect(updated.approved_by).toBe(purchaseManager.id);
  });

  test(`SPOOF: input amount cannot bypass the gate — stored amount governs`, async () => {
    // codex P1 regression: rule eval merges caller input OVER the stored record
    // in `target`, so a rule reading `target.amount` could be bypassed by
    // sending `{ id, amount: 1 }` while the transition approves the stored
    // high-value record. The rule must read the PERSISTED amount via
    // `ctx.record` and block regardless of what the caller claims.
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD + 1);

    const result = (await executor.execute(
      "approve_purchase_request",
      { id, amount: 1 },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(false);
    const after = await store.get("purchase_request", id);
    expect(after.status).toBe("pending");
    // The stored amount must be untouched by the spoofed input.
    expect(after.amount).toBe(MANAGER_APPROVAL_THRESHOLD + 1);
  });

  test("FAIL-CLOSED: a stored record with NO amount blocks a purchase_user", async () => {
    // Regression (claude review on scenario P1): `Number(undefined)` is NaN and
    // the old `!Number.isFinite → return false` path silently fail-OPENED —
    // a non-manager could approve any record whose stored amount was absent.
    // An unknown amount cannot prove it is under the threshold, so the rule
    // must require a manager.
    const record = await store.create("purchase_request", {
      title: "No-amount request",
      requester: "Alice User",
      requester_email: "alice@example.com",
      status: "pending",
    });
    const id = record.id as string;

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect((await store.get("purchase_request", id)).status).toBe("pending");
  });

  test("FAIL-CLOSED: a stored empty-string amount blocks a purchase_user", async () => {
    // Number("") is 0, NOT NaN — a coercion-based normalization would let an
    // empty-string amount sail under the threshold. The rule accepts only a
    // real `typeof "number"` amount; everything else requires a manager.
    const record = await store.create("purchase_request", {
      title: "Empty-amount request",
      amount: "",
      requester: "Alice User",
      requester_email: "alice@example.com",
      status: "pending",
    });
    const id = record.id as string;

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseUser,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect((await store.get("purchase_request", id)).status).toBe("pending");
  });

  test("FAIL-CLOSED: a manager can still approve a record with NO amount", async () => {
    const record = await store.create("purchase_request", {
      title: "No-amount request",
      requester: "Alice User",
      requester_email: "alice@example.com",
      status: "pending",
    });
    const id = record.id as string;

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      purchaseManager,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect((await store.get("purchase_request", id)).status).toBe("approved");
  });

  test("FAIL-CLOSED: a missing stored row (phantom id) ignores the spoofed input amount", async () => {
    // Defense-in-depth (claude round 5): the rule must not fall back to the
    // caller-controlled `target.amount` when no record exists — relying on the
    // state machine to reject phantom ids is a safety net a custom wiring
    // without a `stateMachine` option would not have. Exercised at the
    // condition level because the full executor rejects the phantom id earlier.
    const condition = managerApprovalThresholdRule.condition as (ctx: {
      target: Record<string, unknown>;
      context: Record<string, unknown>;
      actor: Actor;
      record?: Record<string, unknown>;
    }) => boolean;

    const spoofCtx = {
      target: { id: "ghost-id", amount: 1 },
      context: {},
      record: undefined,
    };
    // Non-manager: blocked (condition triggers) despite the low input amount.
    expect(condition({ ...spoofCtx, actor: purchaseUser })).toBe(true);
    // Manager: still allowed to proceed (condition does not trigger).
    expect(condition({ ...spoofCtx, actor: purchaseManager })).toBe(false);
  });

  test("a generic 'manager' / 'admin' actor also satisfies the manager check", async () => {
    const id = await seedPending(store, MANAGER_APPROVAL_THRESHOLD + 1);
    const adminActor: Actor = { type: "human", id: "admin-1", groups: ["admin"] };

    const result = (await executor.execute(
      "approve_purchase_request",
      { id },
      adminActor,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect((await store.get("purchase_request", id)).status).toBe("approved");
  });
});
