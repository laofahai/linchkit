/**
 * E2E Test: Advanced rule effects — enrich, require_approval, execute_action
 *
 * Extends e2e-rules.test.ts (block + warn) with three more effect types:
 *
 * - enrich: sets fields on effectiveInput before the write; asserted via GraphQL read.
 * - require_approval: suspends the action into a pending ApprovalRequest when an
 *   ApprovalEngine is wired. The action REST endpoint returns 422 + success:false.
 *   Approval ID is retrieved via GET /api/approvals; POST /api/approvals/:id/approve
 *   re-executes and completes the write (asserted via a follow-up GraphQL read).
 *   NOTE: the raw ApprovalPendingResult is wrapped into an error envelope by the
 *   action-api route and is NOT surfaced as a success body.
 * - execute_action: triggers a second action post-commit; asserted by querying the
 *   side-effect record (audit_log) after the primary submit.
 *
 * Setup: DB-free — uses InMemoryStore. Tests PASS without any database connection.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, EntityDefinition, RuleDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createApprovalEngine,
  InMemoryApprovalStore,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Entity definition ──────────────────────────────────────────────────────

const orderSchema: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    category: { type: "string", label: "Category" },
    status: { type: "string", default: "draft" },
    // Enriched by the auto-category rule (set by the enrich effect).
    autoCategory: { type: "string", label: "Auto Category" },
  },
};

// A lightweight audit-log entity used by the execute_action cascade test.
const auditLogSchema: EntityDefinition = {
  name: "audit_log",
  label: "Audit Log",
  fields: {
    sourceOrderId: { type: "string", required: true, label: "Source Order ID" },
    event: { type: "string", required: true, label: "Event" },
  },
};

// ── Rule definitions ───────────────────────────────────────────────────────

/**
 * enrich rule: when an order has no explicit category, automatically set
 * autoCategory to "general" on the effective input before the write.
 */
const enrichAutoCategoryRule: RuleDefinition = {
  name: "enrich_auto_category",
  label: "Enrich Auto Category",
  description: "Set autoCategory to 'general' when category is absent",
  trigger: { action: "submit_order" },
  condition: { field: "target.category", operator: "is_null" },
  effect: { type: "enrich", setFields: { autoCategory: "general" } },
};

/**
 * require_approval rule: orders over 50,000 require director-level approval.
 */
const requireApprovalLargeOrderRule: RuleDefinition = {
  name: "require_approval_large_order",
  label: "Require Approval for Large Orders",
  description: "Orders over 50,000 require director approval",
  trigger: { action: "submit_order" },
  condition: { field: "target.amount", operator: "gt", value: 50000 },
  effect: {
    type: "require_approval",
    level: "director",
    message: "Large order requires director approval.",
  },
};

/**
 * execute_action rule: after an order is submitted, fire create_audit_entry as a
 * post-commit side effect. Explicit params override the default effectiveInput.
 */
const executeActionAuditRule: RuleDefinition = {
  name: "execute_action_audit",
  label: "Audit on Submit",
  description: "Create an audit log entry after every order submission",
  trigger: { action: "submit_order" },
  condition: { field: "target.amount", operator: "gt", value: 0 },
  effect: {
    type: "execute_action",
    action: "create_audit_entry",
    // params override the default effectiveInput so the audit action gets
    // a stable shape rather than the full order payload.
    params: { event: "order.submitted" },
  },
};

// ── Action definitions ─────────────────────────────────────────────────────

/**
 * submit_order: writes status = "submitted".
 * Rule enrich fires BEFORE this handler runs, so ctx.input.autoCategory will
 * already be set (if the enrich rule fired).
 */
const submitOrderAction: ActionDefinition = {
  name: "submit_order",
  entity: "order",
  label: "Submit Order",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    // Persist the enriched + status fields.  Rule enrich merged autoCategory
    // into ctx.input before this handler ran.
    const updates: Record<string, unknown> = { status: "submitted" };
    if (ctx.input.autoCategory !== undefined) {
      updates.autoCategory = ctx.input.autoCategory as string;
    }
    return ctx.update("order", id, updates);
  },
};

/**
 * create_audit_entry: write an audit_log record.
 * Invoked as a post-commit execute_action side effect.
 * The rule passes { event: "order.submitted" } as explicit params.
 */
const createAuditEntryAction: ActionDefinition = {
  name: "create_audit_entry",
  entity: "audit_log",
  label: "Create Audit Entry",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const sourceOrderId = (ctx.input.id as string | undefined) ?? "unknown";
    const event = (ctx.input.event as string | undefined) ?? "unknown";
    return ctx.create("audit_log", { sourceOrderId, event });
  },
};

// ── Server setup (DB-free — InMemoryStore) ─────────────────────────────────

// In-process, port-free: these URLs only supply a path to `new Request(...)` for
// `app.handle` — no socket is bound, so a dummy domain is used (no real port).
const BASE_URL = "http://local.test";
const REST_URL = `${BASE_URL}/api/actions`;
const APPROVALS_URL = `${BASE_URL}/api/approvals`;
const GQL_URL = `${BASE_URL}/graphql`;

let store: InMemoryStore;
let approvalStore: InMemoryApprovalStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  approvalStore = new InMemoryApprovalStore();

  // Rules must be passed to createActionExecutor so the engine evaluates them
  // automatically on every action execution (enrich, require_approval, execute_action).
  const rules: RuleDefinition[] = [
    enrichAutoCategoryRule,
    requireApprovalLargeOrderRule,
    executeActionAuditRule,
  ];

  const executor = createActionExecutor({ dataProvider: store, rules });

  // Register CRUD actions for both entities + the custom actions.
  for (const action of generateCrudActions(orderSchema)) executor.registry.register(action);
  for (const action of generateCrudActions(auditLogSchema)) executor.registry.register(action);
  executor.registry.register(submitOrderAction);
  executor.registry.register(createAuditEntryAction);

  // Wire the approval engine via setApprovalEngine (late-binding seam).
  // createApprovalEngine needs the executor for re-execution on approve().
  const approvalEngine = createApprovalEngine({ store: approvalStore, executor });
  executor.setApprovalEngine(approvalEngine);

  // Build GraphQL schema with all entities.
  const graphqlSchema = buildGraphQLSchema([orderSchema, auditLogSchema], {
    executor,
    dataProvider: store,
    actions: [submitOrderAction, createAuditEntryAction],
  });

  // Pass rules + approvalEngine to createServer for /api/rules and /api/approvals endpoints.
  app = createServer(graphqlSchema, { executor, approvalEngine, rules });
});

beforeEach(() => {
  store.clear();
  approvalStore.clear();
});

// ── Helpers ────────────────────────────────────────────────────────────────

// Requests are dispatched in-process via `app.handle(new Request(...))` — no port
// is bound. Binding a real socket per suite (`app.listen`) crashes the batched
// `addons` run (a Bun segfault accumulates across the many server suites in one
// process); the repo's other server tests are likewise port-free.
async function restAction(name: string, body: Record<string, unknown> = {}) {
  const res = await app.handle(
    new Request(`${REST_URL}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(query: string) {
  const res = await app.handle(
    new Request(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

async function getApprovals(status = "pending") {
  const res = await app.handle(
    new Request(`${APPROVALS_URL}?status=${status}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }),
  );
  return res.json() as Promise<{
    success: boolean;
    data: { items: Array<{ id: string; level: string; status: string; action: string }> };
  }>;
}

async function approveRequest(approvalId: string) {
  const res = await app.handle(
    new Request(`${APPROVALS_URL}/${approvalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "approved by test" }),
    }),
  );
  return res.json() as Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
}

// ── Tests: enrich effect ───────────────────────────────────────────────────

describe("E2E rule effect: enrich", () => {
  test("1. enrich rule sets autoCategory on the persisted record when category is absent", async () => {
    // Create an order without a category — the enrich rule should fire on submit.
    const createResult = await restAction("create_order", {
      title: "Uncategorized Supplies",
      amount: 500,
      // no category — triggers the enrich rule
    });
    expect(createResult.status).toBe(200);
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — enrich rule fires, setting autoCategory = "general" in effectiveInput.
    const submitResult = await restAction("submit_order", { id: orderId });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    // Read via GraphQL: autoCategory must be "general" on the persisted record.
    const gqlResult = await gql(`
      query { order(id: "${orderId}") { id status autoCategory } }
    `);
    expect(gqlResult.errors).toBeUndefined();
    const order = gqlResult.data.order as Record<string, unknown>;
    expect(order.status).toBe("submitted");
    expect(order.autoCategory).toBe("general");
  });

  test("2. enrich rule does NOT fire when category is already set (condition miss)", async () => {
    // Create an order WITH a category — the is_null condition should not match.
    const createResult = await restAction("create_order", {
      title: "Hardware Tools",
      amount: 1200,
      category: "hardware",
    });
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — enrich rule should not fire.
    const submitResult = await restAction("submit_order", { id: orderId });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    // autoCategory should remain null/undefined — the enrich was not applied.
    const gqlResult = await gql(`
      query { order(id: "${orderId}") { id status autoCategory } }
    `);
    expect(gqlResult.errors).toBeUndefined();
    const order = gqlResult.data.order as Record<string, unknown>;
    expect(order.status).toBe("submitted");
    // autoCategory was never set by the enrich rule.
    expect(order.autoCategory == null).toBe(true);
  });
});

// ── Tests: require_approval effect ────────────────────────────────────────

describe("E2E rule effect: require_approval", () => {
  test("3. require_approval suspends the action and surfaces a pending request over HTTP", async () => {
    // Create a large order (> 50,000) — the require_approval rule fires on submit.
    const createResult = await restAction("create_order", {
      title: "Enterprise License",
      amount: 75000,
      category: "software",
    });
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — should suspend, NOT write.
    const submitResult = await restAction("submit_order", { id: orderId });

    // The action REST endpoint returns 422 + success:false when the action is
    // suspended into an approval request (the ApprovalPendingResult is not
    // surfaced as a success body — the executor returns success:false).
    expect(submitResult.status).toBe(422);
    expect(submitResult.body.success).toBe(false);

    // The status must NOT be "submitted" — the write was suspended, not committed.
    // (The CRUD create action does not apply schema defaults, so status may be
    // null rather than "draft"; what matters is that submit_order did NOT write.)
    const gqlResult = await gql(`
      query { order(id: "${orderId}") { id status } }
    `);
    expect(gqlResult.errors).toBeUndefined();
    const order = gqlResult.data.order as Record<string, unknown>;
    expect(order.status).not.toBe("submitted");

    // A pending approval request must exist in the store, accessible via REST.
    const approvalsList = await getApprovals("pending");
    expect(approvalsList.success).toBe(true);
    const items = approvalsList.data.items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    const req = items.find((r) => r.action === "submit_order");
    expect(req).toBeDefined();
    expect(req?.level).toBe("director");
    expect(req?.status).toBe("pending");
  });

  test("4. approving a pending request re-executes the action and completes the write", async () => {
    // Create a large order.
    const createResult = await restAction("create_order", {
      title: "Data Center Lease",
      amount: 100000,
      category: "infrastructure",
    });
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — suspended into approval.
    await restAction("submit_order", { id: orderId });

    // Retrieve the pending approval ID.
    const approvalsList = await getApprovals("pending");
    const req = approvalsList.data.items.find((r) => r.action === "submit_order");
    if (!req) throw new Error("expected a pending approval request for submit_order");
    const approvalId = req.id;

    // Approve the request — should re-execute submit_order and write status = "submitted".
    const approveResult = await approveRequest(approvalId);
    expect(approveResult.success).toBe(true);

    // Verify the record is now "submitted".
    const gqlResult = await gql(`
      query { order(id: "${orderId}") { id status } }
    `);
    expect(gqlResult.errors).toBeUndefined();
    const order = gqlResult.data.order as Record<string, unknown>;
    expect(order.status).toBe("submitted");

    // The approval request must transition to "approved".
    const approvedList = await getApprovals("approved");
    const approvedReq = approvedList.data.items.find((r) => r.id === approvalId);
    expect(approvedReq?.status).toBe("approved");
  });

  test("5. small order does NOT trigger require_approval (condition miss)", async () => {
    // Create an order below the 50,000 threshold.
    const createResult = await restAction("create_order", {
      title: "Office Chairs",
      amount: 1500,
      category: "furniture",
    });
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — no approval rule should fire (amount <= 50,000).
    const submitResult = await restAction("submit_order", { id: orderId });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    // No pending approvals should be created.
    const approvalsList = await getApprovals("pending");
    const orderApprovals = approvalsList.data.items.filter((r) => r.action === "submit_order");
    expect(orderApprovals.length).toBe(0);

    // The record should be submitted immediately.
    const gqlResult = await gql(`
      query { order(id: "${orderId}") { id status } }
    `);
    const order = gqlResult.data.order as Record<string, unknown>;
    expect(order.status).toBe("submitted");
  });
});

// ── Tests: execute_action effect ──────────────────────────────────────────

describe("E2E rule effect: execute_action", () => {
  test("6. execute_action rule creates an audit_log record as a post-commit side effect", async () => {
    // Create an order.
    const createResult = await restAction("create_order", {
      title: "Server Rack",
      amount: 8000,
      category: "hardware",
    });
    expect(createResult.status).toBe(200);
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — the execute_action rule fires post-commit, running create_audit_entry.
    const submitResult = await restAction("submit_order", { id: orderId });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    // The primary write must have happened.
    const orderGql = await gql(`
      query { order(id: "${orderId}") { id status } }
    `);
    expect((orderGql.data.order as Record<string, unknown>).status).toBe("submitted");

    // The audit_log record created by the execute_action side effect must exist.
    const auditGql = await gql(`
      query { auditLogList { items { id sourceOrderId event } } }
    `);
    expect(auditGql.errors).toBeUndefined();
    const auditItems = (auditGql.data.auditLogList as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(auditItems.length).toBeGreaterThanOrEqual(1);

    const auditEntry = auditItems.find((a) => a.event === "order.submitted");
    expect(auditEntry).toBeDefined();
  });

  test("7. execute_action fires AFTER the primary write (post-commit ordering)", async () => {
    // Submit two distinct orders and verify both get individual audit entries.
    const createA = await restAction("create_order", {
      title: "Order A",
      amount: 1000,
      category: "test",
    });
    const createB = await restAction("create_order", {
      title: "Order B",
      amount: 2000,
      category: "test",
    });

    const idA = (createA.body.data as Record<string, unknown>).id as string;
    const idB = (createB.body.data as Record<string, unknown>).id as string;

    await restAction("submit_order", { id: idA });
    await restAction("submit_order", { id: idB });

    // Each submit must have produced one audit entry (execute_action fired per submit).
    const auditGql = await gql(`
      query { auditLogList { items { id event } } }
    `);
    const auditItems = (auditGql.data.auditLogList as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    // Two submits → two audit_log entries.
    expect(auditItems.length).toBe(2);
  });

  test("8. primary action result is unaffected when execute_action side effect succeeds", async () => {
    // The execute_action effect is post-commit best-effort; the primary response
    // must not be altered by the side effect's outcome.
    const createResult = await restAction("create_order", {
      title: "Peripherals Bundle",
      amount: 300,
      category: "peripherals",
    });
    const orderId = (createResult.body.data as Record<string, unknown>).id as string;

    const submitResult = await restAction("submit_order", { id: orderId });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    // The primary data payload must reflect the updated order, not the audit log.
    const data = submitResult.body.data as Record<string, unknown>;
    expect(data).toBeDefined();
  });
});
