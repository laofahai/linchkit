import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core";
import { InMemoryStore } from "../src/data/in-memory-store";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ───────────────────────────────────────────────

const orderSchema: SchemaDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    status: { type: "state", machine: "order_lifecycle" },
    approved_by: { type: "string", label: "Approved By" },
  },
};

// ── Custom actions ───────────────────────────────────────

const submitOrderAction: ActionDefinition = {
  name: "submit_order",
  schema: "order",
  label: "Submit Order",
  description: "Submit an order for approval",
  input: {
    reason: { type: "string", label: "Submission Reason" },
    urgent: { type: "boolean", label: "Is Urgent" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    return ctx.update("order", id, {
      status: "submitted",
    });
  },
};

const approveOrderAction: ActionDefinition = {
  name: "approve_order",
  schema: "order",
  label: "Approve Order",
  description: "Approve a submitted order",
  // No input definition — mutation should only accept id
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    return ctx.update("order", id, {
      status: "approved",
      approved_by: ctx.actor.id,
    });
  },
};

// Action without a schema association
const pingAction: ActionDefinition = {
  name: "ping_system",
  schema: "", // empty = no schema
  label: "Ping System",
  description: "Ping the system for health check",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (_ctx) => {
    return { pong: true, timestamp: new Date().toISOString() };
  },
};

// ── Setup ────────────────────────────────────────────────

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

// Register CRUD actions
for (const action of generateCrudActions(orderSchema)) {
  executor.registry.register(action);
}
// Register custom actions
executor.registry.register(submitOrderAction);
executor.registry.register(approveOrderAction);
executor.registry.register(pingAction);

const graphqlSchema = buildGraphQLSchema([orderSchema], {
  executor,
  dataProvider: store,
  actions: [submitOrderAction, approveOrderAction, pingAction],
});

const app = createServer(graphqlSchema);
const port = 3997;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
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

describe("Custom action typed mutations", () => {
  test("submitOrder mutation with typed input returns schema type", async () => {
    // Create an order first
    await store.create("order", {
      id: "ord_001",
      title: "Test Order",
      amount: 100,
      status: "draft",
    });

    const result = await gql(`
			mutation {
				submitOrder(id: "ord_001", input: { reason: "Need it fast", urgent: true }) {
					id
					title
					status
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const order = result.data.submitOrder as Record<string, unknown>;
    expect(order.id).toBe("ord_001");
    expect(order.status).toBe("submitted");
  });

  test("approveOrder mutation without input (id only) returns schema type", async () => {
    await store.create("order", {
      id: "ord_002",
      title: "Approval Test",
      amount: 200,
      status: "submitted",
    });

    const result = await gql(`
			mutation {
				approveOrder(id: "ord_002") {
					id
					status
					approved_by
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const order = result.data.approveOrder as Record<string, unknown>;
    expect(order.id).toBe("ord_002");
    expect(order.status).toBe("approved");
    expect(order.approved_by).toBe("anonymous");
  });

  test("pingSystem mutation without schema returns ActionResult", async () => {
    const result = await gql(`
			mutation {
				pingSystem(id: "irrelevant") {
					success
					data
					executionId
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const actionResult = result.data.pingSystem as Record<string, unknown>;
    expect(actionResult.success).toBe(true);
    expect(actionResult.executionId).toBeDefined();
    const data = JSON.parse(actionResult.data as string);
    expect(data.pong).toBe(true);
  });

  test("existing CRUD mutations still work", async () => {
    const result = await gql(`
			mutation {
				createOrder(input: { title: "CRUD Test", amount: 50 }) {
					id
					title
					amount
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const order = result.data.createOrder as Record<string, unknown>;
    expect(order.title).toBe("CRUD Test");
    expect(order.amount).toBe(50);
  });

  test("generic executeAction still works", async () => {
    const result = await gql(`
			mutation {
				executeAction(
					name: "create_order"
					input: "{\\"title\\": \\"Generic Test\\", \\"amount\\": 75}"
				) {
					success
					data
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const actionResult = result.data.executeAction as Record<string, unknown>;
    expect(actionResult.success).toBe(true);
  });
});
