/**
 * E2E (server-level): the manager-approval-threshold rule enforced through the
 * full HTTP CommandLayer via `app.handle()` (in-process, port-free).
 *
 * This wires the procurement capability's REAL declarative actions + REAL state
 * machine + REAL business rule into a server and drives them over REST, proving
 * the rule blocks / allows through the same path production uses. No seam mocks.
 *
 * An `x-test-role` header selects the acting actor's role so both directions of
 * the manager check are exercised (the no-auth elevated actor is always a
 * manager, which would mask the block — so we resolve the actor explicitly).
 */

import { describe, expect, test } from "bun:test";
import type { Actor } from "@linchkit/core";
import {
  createActionExecutor,
  createStateMachine,
  EntityRegistry,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { approveAction } from "../../../demo/cap-purchase-demo/src/actions/approve";
import { flagForReviewAction } from "../../../demo/cap-purchase-demo/src/actions/flag-for-review";
import { rejectAction } from "../../../demo/cap-purchase-demo/src/actions/reject";
import { submitAction } from "../../../demo/cap-purchase-demo/src/actions/submit";
import { purchaseRequestEntity } from "../../../demo/cap-purchase-demo/src/entities/purchase-request";
import {
  MANAGER_APPROVAL_THRESHOLD,
  managerApprovalThresholdRule,
} from "../../../demo/cap-purchase-demo/src/rules/manager-approval-threshold";
import { purchaseRequestState } from "../../../demo/cap-purchase-demo/src/states/purchase-request";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const entityRegistry = new EntityRegistry();
entityRegistry.register(purchaseRequestEntity);

const executor = createActionExecutor({
  dataProvider: store,
  executionLogger,
  entityRegistry,
  stateMachine: createStateMachine(purchaseRequestState),
  rules: [managerApprovalThresholdRule],
});

const capabilityActions = [submitAction, approveAction, rejectAction, flagForReviewAction];
const allActions = [...generateCrudActions(purchaseRequestEntity), ...capabilityActions];
for (const action of allActions) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([purchaseRequestEntity], {
  executor,
  dataProvider: store,
  actions: capabilityActions,
  executionLogger,
});

// Resolve the actor from a test header so both roles are exercised. Without an
// explicit resolver the server uses the elevated no-auth actor (always a
// manager), which would hide the block.
function resolveRequestActor(request: Request): Actor {
  const role = request.headers.get("x-test-role");
  if (role === "manager") {
    return { type: "human", id: "mgr-001", name: "Manager", groups: ["purchase_manager"] };
  }
  return { type: "human", id: "user-001", name: "User", groups: ["purchase_user"] };
}

const app = createServer(graphqlSchema, {
  executor,
  executionLogger,
  entityRegistry,
  resolveRequestActor,
});

const BASE = "http://local.test";

async function restAction(name: string, body: Record<string, unknown>, role?: "user" | "manager") {
  const res = await app.handle(
    new Request(`${BASE}/api/actions/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(role ? { "x-test-role": role } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(query: string) {
  const res = await app.handle(
    new Request(`${BASE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Create a draft then submit it → pending, returning the record id. */
async function createPending(amount: number): Promise<string> {
  const { body } = await restAction("create_purchase_request", {
    title: "Approval rule test",
    amount,
    requester: "User",
    requester_email: "user@example.com",
  });
  const id = (body.data as Record<string, unknown>).id as string;
  await restAction("submit_purchase_request", { id });
  return id;
}

// ── Tests ────────────────────────────────────────────────

describe("E2E: manager_approval_threshold rule over REST", () => {
  test(`amount <= ${MANAGER_APPROVAL_THRESHOLD}: purchase_user approval succeeds`, async () => {
    const id = await createPending(MANAGER_APPROVAL_THRESHOLD - 500);

    const { status, body } = await restAction("approve_purchase_request", { id }, "user");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("approved");
  });

  test(`amount > ${MANAGER_APPROVAL_THRESHOLD}: purchase_user approval is BLOCKED`, async () => {
    const id = await createPending(MANAGER_APPROVAL_THRESHOLD + 5000);

    const { body } = await restAction("approve_purchase_request", { id }, "user");

    expect(body.success).toBe(false);
    const err = (body.error ?? body.data) as Record<string, unknown>;
    expect(JSON.stringify(err)).toContain("manager approval");

    // The request must still be pending — the block prevented the write.
    const result = await gql(`{ purchaseRequest(id: "${id}") { status } }`);
    const pr = (result.data as Record<string, unknown>).purchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("pending");
  });

  test(`amount > ${MANAGER_APPROVAL_THRESHOLD}: purchase_manager approval succeeds`, async () => {
    const id = await createPending(MANAGER_APPROVAL_THRESHOLD + 5000);

    const { status, body } = await restAction("approve_purchase_request", { id }, "manager");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("approved");
  });

  test("SPOOF over REST: `{ id, amount: 1 }` cannot bypass the gate", async () => {
    // codex P1 regression at the real HTTP seam: the rule must read the stored
    // amount (condition-context `record`), not the caller-merged `target`.
    const id = await createPending(MANAGER_APPROVAL_THRESHOLD + 5000);

    const { body } = await restAction("approve_purchase_request", { id, amount: 1 }, "user");

    expect(body.success).toBe(false);
    const result = await gql(`{ purchaseRequest(id: "${id}") { status amount } }`);
    const pr = (result.data as Record<string, unknown>).purchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("pending");
    expect(pr.amount).toBe(MANAGER_APPROVAL_THRESHOLD + 5000);
  });

  test("flag_purchase_for_review is NOT callable over HTTP (internal-only)", async () => {
    // codex P2 regression: the flow-step helper must not be reachable from
    // external channels, or any caller could overwrite audit_notes.
    const id = await createPending(MANAGER_APPROVAL_THRESHOLD + 5000);

    const { body } = await restAction(
      "flag_purchase_for_review",
      { id, audit_notes: "forged" },
      "user",
    );

    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).toContain("not exposed");
  });
});
