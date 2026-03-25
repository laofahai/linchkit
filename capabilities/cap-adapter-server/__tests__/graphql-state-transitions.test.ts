import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition, StateDefinition } from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core/server";
import { InMemoryStore } from "../src/data/in-memory-store";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── State definition ─────────────────────────────────────

const orderLifecycle: StateDefinition = {
  name: "order_lifecycle",
  schema: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected", "cancelled"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit" },
    { from: "submitted", to: "approved", action: "approve" },
    { from: "submitted", to: "rejected", action: "reject" },
    { from: ["draft", "submitted"], to: "cancelled", action: "cancel" },
  ],
  meta: {
    draft: { label: "Draft" },
    submitted: { label: "Submitted" },
    approved: { label: "Approved" },
    rejected: { label: "Rejected" },
    cancelled: { label: "Cancelled" },
  },
};

// ── Schema definition ────────────────────────────────────

const orderSchema: SchemaDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", label: "Amount" },
    status: { type: "state", machine: "order_lifecycle", default: "draft" },
  },
};

// ── Setup ────────────────────────────────────────────────

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

// Register CRUD actions with state definitions for validation
for (const action of generateCrudActions(orderSchema, {
  stateDefinitions: [orderLifecycle],
})) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([orderSchema], {
  executor,
  dataProvider: store,
  stateDefinitions: [orderLifecycle],
});

const app = createServer(graphqlSchema);
const port = 3996;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ───────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ────────────────────────────────────────────────

describe("GraphQL state transition validation", () => {
  test("update mutation rejects invalid state transition", async () => {
    // Create an order in draft state
    await store.create("order", {
      id: "order_1",
      title: "Test Order",
      amount: 100,
      status: "draft",
    });

    // Try to transition directly from draft to approved (not allowed)
    const result = await gql(`
      mutation {
        updateOrder(id: "order_1", input: { title: "Test Order", status: "approved" }) {
          id
          status
        }
      }
    `);

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const errorMsg = (result.errors![0] as { message: string }).message;
    expect(errorMsg).toContain("State transition not allowed");
    expect(errorMsg).toContain("draft");
    expect(errorMsg).toContain("approved");
  });

  test("update mutation allows valid state transition", async () => {
    await store.create("order", {
      id: "order_2",
      title: "Valid Transition",
      amount: 200,
      status: "draft",
    });

    // draft -> submitted is allowed
    const result = await gql(`
      mutation {
        updateOrder(id: "order_2", input: { title: "Valid Transition", status: "submitted" }) {
          id
          status
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.updateOrder as Record<string, unknown>;
    expect(order.status).toBe("submitted");
  });

  test("update mutation allows non-state field changes without state validation", async () => {
    await store.create("order", {
      id: "order_3",
      title: "No State Change",
      amount: 100,
      status: "draft",
    });

    // Update only the title — no state field change
    const result = await gql(`
      mutation {
        updateOrder(id: "order_3", input: { title: "Updated Title" }) {
          id
          title
          status
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.updateOrder as Record<string, unknown>;
    expect(order.title).toBe("Updated Title");
    expect(order.status).toBe("draft");
  });
});

describe("availableTransitions query", () => {
  test("returns correct transitions from draft state", async () => {
    await store.create("order", {
      id: "avail_1",
      title: "Draft Order",
      status: "draft",
    });

    const result = await gql(`
      query {
        orderAvailableTransitions(id: "avail_1") {
          from
          to
          action
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const transitions = result.data.orderAvailableTransitions as Array<{
      from: string;
      to: string;
      action: string;
    }>;

    // From draft: submit -> submitted, cancel -> cancelled
    expect(transitions.length).toBe(2);
    expect(transitions).toContainEqual({ from: "draft", to: "submitted", action: "submit" });
    expect(transitions).toContainEqual({ from: "draft", to: "cancelled", action: "cancel" });
  });

  test("returns correct transitions from submitted state", async () => {
    await store.create("order", {
      id: "avail_2",
      title: "Submitted Order",
      status: "submitted",
    });

    const result = await gql(`
      query {
        orderAvailableTransitions(id: "avail_2") {
          from
          to
          action
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const transitions = result.data.orderAvailableTransitions as Array<{
      from: string;
      to: string;
      action: string;
    }>;

    // From submitted: approve -> approved, reject -> rejected, cancel -> cancelled
    expect(transitions.length).toBe(3);
    expect(transitions).toContainEqual({ from: "submitted", to: "approved", action: "approve" });
    expect(transitions).toContainEqual({ from: "submitted", to: "rejected", action: "reject" });
    expect(transitions).toContainEqual({ from: "submitted", to: "cancelled", action: "cancel" });
  });

  test("returns empty array for terminal state", async () => {
    await store.create("order", {
      id: "avail_3",
      title: "Approved Order",
      status: "approved",
    });

    const result = await gql(`
      query {
        orderAvailableTransitions(id: "avail_3") {
          from
          to
          action
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const transitions = result.data.orderAvailableTransitions as unknown[];
    expect(transitions.length).toBe(0);
  });
});

describe("transition mutation", () => {
  test("valid transition succeeds", async () => {
    await store.create("order", {
      id: "trans_1",
      title: "To Submit",
      amount: 500,
      status: "draft",
    });

    const result = await gql(`
      mutation {
        transitionOrder(id: "trans_1", to: "submitted") {
          id
          title
          status
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.transitionOrder as Record<string, unknown>;
    expect(order.status).toBe("submitted");
    expect(order.title).toBe("To Submit");

    // Verify persisted in store
    const stored = await store.get("order", "trans_1");
    expect(stored.status).toBe("submitted");
  });

  test("invalid transition is rejected with clear error", async () => {
    await store.create("order", {
      id: "trans_2",
      title: "Draft Order",
      status: "draft",
    });

    // draft -> approved is not a valid direct transition
    const result = await gql(`
      mutation {
        transitionOrder(id: "trans_2", to: "approved") {
          id
          status
        }
      }
    `);

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const errorMsg = (result.errors![0] as { message: string }).message;
    expect(errorMsg).toContain("State transition not allowed");
    expect(errorMsg).toContain("draft");
    expect(errorMsg).toContain("approved");

    // Verify state did not change
    const stored = await store.get("order", "trans_2");
    expect(stored.status).toBe("draft");
  });

  test("multi-step transition works correctly", async () => {
    await store.create("order", {
      id: "trans_3",
      title: "Multi Step",
      status: "draft",
    });

    // Step 1: draft -> submitted
    const r1 = await gql(`
      mutation {
        transitionOrder(id: "trans_3", to: "submitted") {
          id
          status
        }
      }
    `);
    expect(r1.errors).toBeUndefined();
    expect((r1.data.transitionOrder as Record<string, unknown>).status).toBe("submitted");

    // Step 2: submitted -> approved
    const r2 = await gql(`
      mutation {
        transitionOrder(id: "trans_3", to: "approved") {
          id
          status
        }
      }
    `);
    expect(r2.errors).toBeUndefined();
    expect((r2.data.transitionOrder as Record<string, unknown>).status).toBe("approved");
  });

  test("transition on non-existent record returns error", async () => {
    const result = await gql(`
      mutation {
        transitionOrder(id: "nonexistent", to: "submitted") {
          id
          status
        }
      }
    `);

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    const errorMsg = (result.errors![0] as { message: string }).message;
    expect(errorMsg).toContain("not found");
  });
});
