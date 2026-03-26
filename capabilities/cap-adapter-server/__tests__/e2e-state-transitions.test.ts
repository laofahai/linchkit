/**
 * E2E Test: State machine transitions
 *
 * Validates the full state lifecycle for a purchase_request schema:
 * - draft → pending (submit)
 * - pending → approved (approve)
 * - pending → rejected (reject)
 * - rejected → pending (resubmit)
 * - Invalid transitions are rejected
 *
 * Uses InMemoryStore with state definitions for deterministic testing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, SchemaDefinition, StateDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── State definition ─────────────────────────────────────

const purchaseLifecycle: StateDefinition = {
  name: "purchase_lifecycle",
  schema: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit" },
    { from: "pending", to: "approved", action: "approve" },
    { from: "pending", to: "rejected", action: "reject" },
    { from: "rejected", to: "pending", action: "resubmit" },
  ],
  meta: {
    draft: { label: "Draft" },
    pending: { label: "Pending Approval" },
    approved: { label: "Approved" },
    rejected: { label: "Rejected" },
  },
};

// ── Schema definition ────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", label: "Department" },
    status: { type: "state", machine: "purchase_lifecycle", default: "draft" },
  },
};

// ── Custom actions for state transitions ─────────────────

const submitAction: ActionDefinition = {
  name: "submit_purchase_request",
  schema: "purchase_request",
  label: "Submit",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "draft") {
      throw new Error(`Cannot submit: current status is "${record.status}", expected "draft"`);
    }
    return ctx.update("purchase_request", id, { status: "pending" });
  },
};

const approveAction: ActionDefinition = {
  name: "approve_purchase_request",
  schema: "purchase_request",
  label: "Approve",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "pending") {
      throw new Error(`Cannot approve: current status is "${record.status}", expected "pending"`);
    }
    return ctx.update("purchase_request", id, { status: "approved" });
  },
};

const rejectAction: ActionDefinition = {
  name: "reject_purchase_request",
  schema: "purchase_request",
  label: "Reject",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "pending") {
      throw new Error(`Cannot reject: current status is "${record.status}", expected "pending"`);
    }
    return ctx.update("purchase_request", id, { status: "rejected" });
  },
};

const resubmitAction: ActionDefinition = {
  name: "resubmit_purchase_request",
  schema: "purchase_request",
  label: "Resubmit",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "rejected") {
      throw new Error(`Cannot resubmit: current status is "${record.status}", expected "rejected"`);
    }
    return ctx.update("purchase_request", id, { status: "pending" });
  },
};

// ── Setup ────────────────────────────────────────────────

const PORT = 32110;
const GQL_URL = `http://localhost:${PORT}/graphql`;
const REST_URL = `http://localhost:${PORT}/api/actions`;

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  const crudActions = generateCrudActions(purchaseRequestSchema, {
    stateDefinitions: [purchaseLifecycle],
  });
  const customActions = [submitAction, approveAction, rejectAction, resubmitAction];

  for (const action of [...crudActions, ...customActions]) {
    executor.registry.register(action);
  }

  const graphqlSchema = buildGraphQLSchema([purchaseRequestSchema], {
    executor,
    dataProvider: store,
    actions: customActions,
    stateDefinitions: [purchaseLifecycle],
  });

  app = createServer(graphqlSchema, { executor });
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

async function restAction(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${REST_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── Tests ─────────────────────────────────────────────────

describe("E2E state machine transitions", () => {
  test("1. Create purchase_request starts in draft status", async () => {
    const result = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Laptops", amount: 5000, department: "Engineering" }) {
          id title amount status _version
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const pr = result.data.createPurchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("draft");
    expect(pr.title).toBe("Laptops");
  });

  test("2. Submit: draft → pending", async () => {
    // Create in draft
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Monitors", amount: 3000 }) {
          id status
        }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;

    // Submit via REST action
    const { status, body } = await restAction("submit_purchase_request", { id });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("pending");

    // Verify via GraphQL
    const getResult = await gql(`
      query { purchaseRequest(id: "${id}") { id status } }
    `);
    expect((getResult.data.purchaseRequest as Record<string, unknown>).status).toBe("pending");
  });

  test("3. Approve: pending → approved", async () => {
    // Create and submit
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Keyboards", amount: 500 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });

    // Approve via REST
    const { status, body } = await restAction("approve_purchase_request", { id });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("approved");

    // Verify via GraphQL
    const getResult = await gql(`
      query { purchaseRequest(id: "${id}") { id status } }
    `);
    expect((getResult.data.purchaseRequest as Record<string, unknown>).status).toBe("approved");
  });

  test("4. Invalid transition: approved → draft should fail", async () => {
    // Create, submit, approve
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Desk", amount: 800 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });
    await restAction("approve_purchase_request", { id });

    // Try invalid transition via updateMutation (approved → draft)
    const result = await gql(`
      mutation {
        updatePurchaseRequest(id: "${id}", input: { status: "draft" }) {
          id status
        }
      }
    `);

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const errorMsg = (result.errors![0] as { message: string }).message;
    expect(errorMsg).toContain("State transition not allowed");

    // Verify status unchanged
    const getResult = await gql(`
      query { purchaseRequest(id: "${id}") { status } }
    `);
    expect((getResult.data.purchaseRequest as Record<string, unknown>).status).toBe("approved");
  });

  test("5. Reject: pending → rejected", async () => {
    // Create and submit
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Supplies", amount: 200 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });

    // Reject
    const { status, body } = await restAction("reject_purchase_request", { id });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("rejected");
  });

  test("6. Resubmit: rejected → pending", async () => {
    // Create, submit, reject
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Software License", amount: 1500 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });
    await restAction("reject_purchase_request", { id });

    // Verify rejected
    const beforeResubmit = await gql(`
      query { purchaseRequest(id: "${id}") { status } }
    `);
    expect((beforeResubmit.data.purchaseRequest as Record<string, unknown>).status).toBe("rejected");

    // Resubmit
    const { status, body } = await restAction("resubmit_purchase_request", { id });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect((body.data as Record<string, unknown>).status).toBe("pending");

    // Verify pending again
    const afterResubmit = await gql(`
      query { purchaseRequest(id: "${id}") { status } }
    `);
    expect((afterResubmit.data.purchaseRequest as Record<string, unknown>).status).toBe("pending");
  });

  test("7. Cannot submit an already pending request", async () => {
    // Create and submit
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Already Pending", amount: 100 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });

    // Try to submit again
    const { status, body } = await restAction("submit_purchase_request", { id });
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("pending");
  });

  test("8. Cannot approve a draft request (must be pending first)", async () => {
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Not Yet Submitted", amount: 100 }) { id }
      }
    `);
    const id = (createResult.data.createPurchaseRequest as Record<string, unknown>).id as string;

    const { status, body } = await restAction("approve_purchase_request", { id });
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("draft");
  });

  test("9. Transition mutation: draft → pending via transitionPurchaseRequest", async () => {
    await store.create("purchase_request", {
      id: "trans_pr_1",
      title: "Transition Test",
      amount: 999,
      status: "draft",
    });

    const result = await gql(`
      mutation {
        transitionPurchaseRequest(id: "trans_pr_1", to: "pending") {
          id status
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const pr = result.data.transitionPurchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("pending");
  });

  test("10. Available transitions query returns correct options", async () => {
    await store.create("purchase_request", {
      id: "avail_pr",
      title: "Availability Test",
      amount: 100,
      status: "pending",
    });

    const result = await gql(`
      query {
        purchaseRequestAvailableTransitions(id: "avail_pr") {
          from to action
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const transitions = result.data.purchaseRequestAvailableTransitions as Array<{
      from: string;
      to: string;
      action: string;
    }>;

    // From pending: approve → approved, reject → rejected
    expect(transitions.length).toBe(2);
    expect(transitions).toContainEqual({ from: "pending", to: "approved", action: "approve" });
    expect(transitions).toContainEqual({ from: "pending", to: "rejected", action: "reject" });
  });

  test("11. Full state lifecycle: draft → pending → rejected → pending → approved", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createPurchaseRequest(input: { title: "Full Lifecycle", amount: 10000 }) { id status }
      }
    `);
    const created = createResult.data.createPurchaseRequest as Record<string, unknown>;
    const id = created.id as string;
    expect(created.status).toBe("draft");

    // Submit (draft → pending)
    const submitResult = await restAction("submit_purchase_request", { id });
    expect((submitResult.body.data as Record<string, unknown>).status).toBe("pending");

    // Reject (pending → rejected)
    const rejectResult = await restAction("reject_purchase_request", { id });
    expect((rejectResult.body.data as Record<string, unknown>).status).toBe("rejected");

    // Resubmit (rejected → pending)
    const resubmitResult = await restAction("resubmit_purchase_request", { id });
    expect((resubmitResult.body.data as Record<string, unknown>).status).toBe("pending");

    // Approve (pending → approved)
    const approveResult = await restAction("approve_purchase_request", { id });
    expect((approveResult.body.data as Record<string, unknown>).status).toBe("approved");

    // Final verification
    const finalResult = await gql(`
      query { purchaseRequest(id: "${id}") { id title status } }
    `);
    const final = finalResult.data.purchaseRequest as Record<string, unknown>;
    expect(final.title).toBe("Full Lifecycle");
    expect(final.status).toBe("approved");
  });
});
