/**
 * Enforcement proof for the late-payer credit-raise rule (Build B, PR2).
 *
 * This is the real end-to-end proof — NOT a unit test of the condition in
 * isolation. It boots the EXACT `bun run dev:server` assembly via `createDevApp`
 * (the same `assembleDevSchema` + `createServer` wiring, minus binding a port)
 * with the REAL shipped capabilities `cap-partner` + `cap-sales`, so the
 * credit-policy rule registered on cap-sales (`rules: [latePayerCreditRaiseRule]`)
 * is evaluated by the action engine on every `update_partner` execution through
 * the real rule-in-action wiring (core `evaluateActionRules`).
 *
 * What it proves:
 *   1. A late payer (`is_late_payer=true`) whose `credit_limit` is RAISED →
 *      `update_partner` SUSPENDS into a pending approval request (HTTP 422,
 *      success:false) instead of committing the write. This is the key proof:
 *      a `defineRule` with effect `require_approval` actually suspends a
 *      credit-changing CRUD action at execution time.
 *   2. A partner in good standing (`is_late_payer=false`) whose `credit_limit`
 *      is raised → the action PROCEEDS normally (HTTP 200, success, write
 *      committed, no approval request).
 *   3. A late payer whose `credit_limit` is LOWERED → proceeds normally (the
 *      gate constrains raises only).
 *
 * DB-free (InMemoryStore fallback) and port-free: requests are dispatched
 * in-process via `app.handle(new Request(...))` — NEVER `app.listen(PORT)`
 * (a bound socket segfaults the batched runner).
 */

import { describe, expect, it } from "bun:test";
import { capAdapterServer, createDevApp } from "@linchkit/cap-adapter-server";
import type { CodeCondition } from "@linchkit/core";
import { latePayerCreditRaiseRule } from "../credit-policy.rule";
import { partnerCapability } from "../partner";
import { salesCapability } from "../sales";

// ── Response shapes (no `any`) ───────────────────────────────────────────────

interface ActionSuccess {
  success: true;
  data: Record<string, unknown>;
  meta: { executionId: string };
}

interface ActionError {
  success: false;
  error: { code: string; message: string };
  meta?: { executionId?: string };
}

type ActionResponse = ActionSuccess | ActionError;

interface ApprovalItem {
  id: string;
  level: string;
  status: string;
  action: string;
}

interface ApprovalListResponse {
  success: boolean;
  data: { items: ApprovalItem[] };
}

interface GraphQLResponse<T = Record<string, unknown>> {
  data: T;
  errors?: Array<{ message: string }>;
}

// ── In-process app (DB-free, port-free) ──────────────────────────────────────

/**
 * Boot the dev app from the REAL partner + sales capabilities. The adapter
 * provides the GraphQL/REST transport; cap-partner contributes the `partner`
 * entity (so CRUD `create_partner` / `update_partner` are generated), and
 * cap-sales folds in `credit_limit` + `is_late_payer` AND registers the
 * credit-policy rule. A fresh app = a fresh InMemoryStore, so each test is
 * isolated.
 */
function buildApp(): ReturnType<typeof createDevApp>["app"] {
  return createDevApp([capAdapterServer, partnerCapability, salesCapability], { cors: false }).app;
}

// ── Request helpers ──────────────────────────────────────────────────────────

async function postAction(
  app: ReturnType<typeof createDevApp>["app"],
  name: string,
  input: Record<string, unknown> = {},
): Promise<{ status: number; body: ActionResponse }> {
  const res = await app.handle(
    new Request(`http://local.test/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return { status: res.status, body: (await res.json()) as ActionResponse };
}

async function gql(
  app: ReturnType<typeof createDevApp>["app"],
  query: string,
): Promise<GraphQLResponse> {
  const res = await app.handle(
    new Request("http://local.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return (await res.json()) as GraphQLResponse;
}

async function pendingApprovals(
  app: ReturnType<typeof createDevApp>["app"],
): Promise<ApprovalItem[]> {
  const res = await app.handle(
    new Request("http://local.test/api/approvals?status=pending", {
      method: "GET",
      headers: { "content-type": "application/json" },
    }),
  );
  const body = (await res.json()) as ApprovalListResponse;
  return body.data.items;
}

/** Create a partner and return its id. Asserts the create itself succeeded. */
async function createPartner(
  app: ReturnType<typeof createDevApp>["app"],
  fields: Record<string, unknown>,
): Promise<string> {
  const { status, body } = await postAction(app, "create_partner", fields);
  expect(status).toBe(200);
  expect(body.success).toBe(true);
  return (body as ActionSuccess).data.id as string;
}

/** Read a partner's credit_limit via GraphQL (proves what was persisted). */
async function readCreditLimit(
  app: ReturnType<typeof createDevApp>["app"],
  id: string,
): Promise<unknown> {
  const result = await gql(app, `query { partner(id: "${id}") { id credit_limit } }`);
  expect(result.errors).toBeUndefined();
  const partner = result.data.partner as Record<string, unknown>;
  return partner.credit_limit;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("late-payer credit-raise rule (real update_partner enforcement, in-process)", () => {
  it("1. late payer + RAISE credit_limit → update_partner SUSPENDS into a pending approval (the key proof)", async () => {
    const app = buildApp();

    // A flagged late payer starting at a 1000 limit.
    const id = await createPartner(app, {
      name: "Risky Co",
      is_late_payer: true,
      credit_limit: 1000,
    });

    // Raise the limit 1000 → 5000. The rule fires and yields require_approval.
    const { status, body } = await postAction(app, "update_partner", { id, credit_limit: 5000 });

    // The action REST endpoint returns 422 + success:false when the action is
    // suspended into an approval request — the write is NOT committed.
    expect(status).toBe(422);
    expect(body.success).toBe(false);

    // The persisted limit must STILL be 1000 — the raise was suspended, not written.
    expect(await readCreditLimit(app, id)).toBe(1000);

    // A pending approval request for update_partner must exist, at the manager level.
    const items = await pendingApprovals(app);
    const req = items.find((r) => r.action === "update_partner");
    expect(req).toBeDefined();
    expect(req?.level).toBe("manager");
    expect(req?.status).toBe("pending");
  });

  it("2. partner in good standing + RAISE credit_limit → proceeds normally (no approval)", async () => {
    const app = buildApp();

    // Not flagged — the gate must not fire.
    const id = await createPartner(app, {
      name: "Trusty Inc",
      is_late_payer: false,
      credit_limit: 1000,
    });

    const { status, body } = await postAction(app, "update_partner", { id, credit_limit: 5000 });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // The raise was committed.
    expect(await readCreditLimit(app, id)).toBe(5000);

    // No approval request was created.
    const items = await pendingApprovals(app);
    expect(items.filter((r) => r.action === "update_partner")).toHaveLength(0);
  });

  it("3. late payer + LOWER credit_limit → proceeds normally (gate constrains raises only)", async () => {
    const app = buildApp();

    // Flagged, but the change is a DECREASE, which the gate must let through.
    const id = await createPartner(app, {
      name: "Shrinking Ltd",
      is_late_payer: true,
      credit_limit: 5000,
    });

    const { status, body } = await postAction(app, "update_partner", { id, credit_limit: 2000 });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // The decrease was committed.
    expect(await readCreditLimit(app, id)).toBe(2000);

    // No approval request was created.
    const items = await pendingApprovals(app);
    expect(items.filter((r) => r.action === "update_partner")).toHaveLength(0);
  });

  it('4. late payer + RAISE via a STRING credit_limit ("5000") → still SUSPENDS (a string-encoded raise must not bypass the gate)', async () => {
    const app = buildApp();

    const id = await createPartner(app, {
      name: "Sneaky Co",
      is_late_payer: true,
      credit_limit: 1000,
    });

    // Under lenient action validation a string `credit_limit` reaches the rule
    // unchanged. It MUST be coerced and gated, not waved through (the bypass).
    const { status, body } = await postAction(app, "update_partner", { id, credit_limit: "5000" });
    expect(status).toBe(422);
    expect(body.success).toBe(false);

    // The raise was suspended, not written.
    expect(await readCreditLimit(app, id)).toBe(1000);

    const items = await pendingApprovals(app);
    expect(items.find((r) => r.action === "update_partner")).toBeDefined();
  });

  it("5. late payer + update an UNRELATED field (no credit_limit in payload) → proceeds (gate must not fire on non-credit changes)", async () => {
    const app = buildApp();

    const id = await createPartner(app, {
      name: "Flagged Co",
      is_late_payer: true,
      credit_limit: 1000,
    });

    // Only `name` changes — `credit_limit` is absent from the input. The engine
    // merges target = {...stored, ...input}, so proposed === current → no gate.
    const { status, body } = await postAction(app, "update_partner", {
      id,
      name: "Flagged Co (renamed)",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // The credit limit is unchanged, and no approval was created.
    expect(await readCreditLimit(app, id)).toBe(1000);
    const items = await pendingApprovals(app);
    expect(items.filter((r) => r.action === "update_partner")).toHaveLength(0);
  });

  it("6. single-call spoof: clear is_late_payer AND raise in ONE write → still SUSPENDS (flag read from stored record)", async () => {
    const app = buildApp();

    const id = await createPartner(app, {
      name: "Spoofy Co",
      is_late_payer: true,
      credit_limit: 1000,
    });

    // The caller tries to clear the flag and raise in the same write. The
    // credit rule reads is_late_payer from the STORED record (still true), so
    // the raise is gated regardless of the input flag.
    const { status, body } = await postAction(app, "update_partner", {
      id,
      is_late_payer: false,
      credit_limit: 5000,
    });
    expect(status).toBe(422);
    expect(body.success).toBe(false);

    // Nothing was committed (neither the cleared flag nor the raise).
    expect(await readCreditLimit(app, id)).toBe(1000);
    const items = await pendingApprovals(app);
    expect(items.find((r) => r.action === "update_partner")).toBeDefined();
  });

  it("7. two-step bypass closed: clearing is_late_payer alone → SUSPENDS (anti-bypass rule)", async () => {
    const app = buildApp();

    const id = await createPartner(app, {
      name: "Two Step Co",
      is_late_payer: true,
      credit_limit: 1000,
    });

    // Step 1 of the bypass — clearing the flag — is itself gated, so the
    // two-step sequence can never reach an ungated raise.
    const { status, body } = await postAction(app, "update_partner", { id, is_late_payer: false });
    expect(status).toBe(422);
    expect(body.success).toBe(false);

    const items = await pendingApprovals(app);
    expect(items.find((r) => r.action === "update_partner")).toBeDefined();
  });

  it("8. flagging a good-standing partner (false → true) is NOT gated", async () => {
    const app = buildApp();

    const id = await createPartner(app, {
      name: "Newly Risky Co",
      is_late_payer: false,
      credit_limit: 1000,
    });

    // Setting the flag is the safe direction — never gated.
    const { status, body } = await postAction(app, "update_partner", { id, is_late_payer: true });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const items = await pendingApprovals(app);
    expect(items.filter((r) => r.action === "update_partner")).toHaveLength(0);
  });
});

// ── Numeric-coercion units (deterministic, no store round-trip) ───────────────
//
// The end-to-end tests above run through the InMemoryStore, which keeps native
// numbers. A real Drizzle `numeric()` column round-trips the STORED baseline as
// a string, so the condition must compare a string baseline numerically rather
// than mistake it for an absent (zero) limit. These unit cases pin that
// coercion directly on the shipped condition, independent of the store backend.

describe("late-payer credit-raise condition — numeric coercion", () => {
  const condition = latePayerCreditRaiseRule.condition as CodeCondition;
  const evaluate = (record: Record<string, unknown> | null, target: Record<string, unknown>) =>
    condition({ record, target } as unknown as Parameters<CodeCondition>[0]);

  it("string PROPOSED raise is gated (number baseline)", async () => {
    expect(
      await evaluate({ is_late_payer: true, credit_limit: 1000 }, { credit_limit: "5000" }),
    ).toBe(true);
  });

  it("string STORED baseline is compared numerically, not as 0 → a decrease is NOT gated", async () => {
    expect(
      await evaluate({ is_late_payer: true, credit_limit: "1000" }, { credit_limit: 500 }),
    ).toBe(false);
  });

  it("both string — a raise is still gated", async () => {
    expect(
      await evaluate({ is_late_payer: true, credit_limit: "1000" }, { credit_limit: "5000" }),
    ).toBe(true);
  });

  it("non-numeric proposed value (changed) FAILS CLOSED → gated", async () => {
    // "abc" is not a finite number and differs from the stored 1000, so the
    // rule cannot prove it is safe → require approval rather than fail open.
    expect(
      await evaluate({ is_late_payer: true, credit_limit: 1000 }, { credit_limit: "abc" }),
    ).toBe(true);
  });

  it("Infinity proposed value FAILS CLOSED → gated (must not bypass the gate)", async () => {
    expect(
      await evaluate(
        { is_late_payer: true, credit_limit: 1000 },
        { credit_limit: Number.POSITIVE_INFINITY },
      ),
    ).toBe(true);
  });

  it("string baseline with an equal string proposed (no-op) is not gated", async () => {
    expect(
      await evaluate({ is_late_payer: true, credit_limit: "1000" }, { credit_limit: "1000" }),
    ).toBe(false);
  });

  it("non-finite proposed that is unchanged from a non-finite stored value is not gated", async () => {
    // Defensive: if both sides are the same non-finite value there is no change
    // to gate (cannot happen via a normal write, but the guard stays correct).
    const same = "abc";
    expect(
      await evaluate({ is_late_payer: true, credit_limit: same }, { credit_limit: same }),
    ).toBe(false);
  });

  it("null baseline with undefined proposed (no-op) is not gated", async () => {
    // A nullable column reads back as null; an absent input leaves credit_limit
    // undefined. Both-nullish must be treated as no change, not `undefined !==
    // null` → gated.
    expect(
      await evaluate({ is_late_payer: true, credit_limit: null }, { credit_limit: undefined }),
    ).toBe(false);
  });
});
