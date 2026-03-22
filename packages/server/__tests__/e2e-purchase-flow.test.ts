/**
 * End-to-end test: Purchase management scenario.
 *
 * Validates the complete flow: Schema → Action → State transition →
 * Execution Log → GraphQL query → Error handling.
 *
 * Uses the same demo setup as dev.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryExecutionLogger, SchemaRegistry } from "@linchkit/core";
import { InMemoryStore } from "../src/data/in-memory-store";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ───────────────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", label: "Department" },
    requester: { type: "string", label: "Requester" },
    status: { type: "state", machine: "purchase_lifecycle", default: "draft" },
    priority: {
      type: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      label: "Priority",
    },
  },
};

// ── Custom actions ───────────────────────────────────────

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
  // No permission restriction for testing with anonymous actor
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

// ── Setup ────────────────────────────────────────────────

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const schemaRegistry = new SchemaRegistry();
schemaRegistry.register(purchaseRequestSchema);

const executor = createActionExecutor({ dataProvider: store, executionLogger });

const allActions = [...generateCrudActions(purchaseRequestSchema), submitAction, approveAction];
for (const action of allActions) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([purchaseRequestSchema], {
  executor,
  store,
  actions: [submitAction, approveAction],
  executionLogger,
});

const app = createServer(graphqlSchema, { executor, executionLogger, schemaRegistry });
const PORT = 4020;
const BASE = `http://localhost:${PORT}`;

async function restAction(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function graphql(query: string) {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function getExecutions(params = "") {
  const res = await fetch(`${BASE}/api/executions${params ? `?${params}` : ""}`);
  return (await res.json()) as Record<string, unknown>;
}

// ── Lifecycle ────────────────────────────────────────────

beforeAll(() => {
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

// ── Tests ────────────────────────────────────────────────

describe("E2E: Purchase management flow", () => {
  let createdId: string;

  test("1. Health check", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("2. Create a purchase request via REST", async () => {
    const { status, body } = await restAction("create_purchase_request", {
      title: "E2E Test Purchase",
      amount: 5000,
      department: "Engineering",
      requester: "e2e_tester",
      priority: "high",
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.title).toBe("E2E Test Purchase");
    expect(data.amount).toBe(5000);
    expect(data.id).toBeDefined();
    expect(data.tenant_id).toBeNull();
    expect(data._version).toBe(1);

    createdId = data.id as string;
  });

  test("3. Query via GraphQL — record exists", async () => {
    const result = await graphql(`{
			purchaseRequest(id: "${createdId}") {
				id title amount department
			}
		}`);

    const data = (result.data as Record<string, unknown>).purchaseRequest as Record<
      string,
      unknown
    >;
    expect(data.id).toBe(createdId);
    expect(data.title).toBe("E2E Test Purchase");
    expect(data.amount).toBe(5000);
  });

  test("4. Submit the purchase request (draft → pending)", async () => {
    // Create handler injects default state "draft" from schema definition
    const { status, body } = await restAction("submit_purchase_request", {
      id: createdId,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe("pending");
  });

  test("5. Cannot submit again (already pending) → error", async () => {
    const { status, body } = await restAction("submit_purchase_request", {
      id: createdId,
    });

    expect(status).toBe(422);
    expect(body.success).toBe(false);

    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("pending");
    expect(err.message as string).toContain("draft");
  });

  test("6. GraphQL list with pagination", async () => {
    const result = await graphql(`{
			purchaseRequestList(pageSize: 10) {
				items { id title status }
				total
			}
		}`);

    const list = (result.data as Record<string, unknown>).purchaseRequestList as Record<
      string,
      unknown
    >;
    expect(list.total).toBeGreaterThanOrEqual(1);

    const items = list.items as Array<Record<string, unknown>>;
    const found = items.find((i) => i.id === createdId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");
  });

  test("7. GraphQL typed mutation — submit via GraphQL", async () => {
    // Create another record for GraphQL mutation test
    const createResult = await restAction("create_purchase_request", {
      title: "GraphQL Mutation Test",
      amount: 1000,
    });
    const newId = (createResult.body.data as Record<string, unknown>).id as string;
    // Default state "draft" is injected by create handler, no manual override needed

    const result = await graphql(`mutation {
			submitPurchaseRequest(id: "${newId}") {
				id status
			}
		}`);

    expect(result.errors).toBeUndefined();
    const data = (result.data as Record<string, unknown>).submitPurchaseRequest as Record<
      string,
      unknown
    >;
    expect(data.status).toBe("pending");
  });
});

describe("E2E: Execution Log", () => {
  test("8. REST: execution logs are recorded", async () => {
    const result = await getExecutions();

    expect((result as Record<string, unknown>).success).toBe(true);
    const data = (result as Record<string, unknown>).data as Record<string, unknown>;
    const total = data.total as number;
    expect(total).toBeGreaterThanOrEqual(3); // at least create + submit + failed submit

    const items = data.items as Array<Record<string, unknown>>;
    // Should have both succeeded and failed entries
    const statuses = new Set(items.map((i) => i.status));
    expect(statuses.has("succeeded")).toBe(true);
    expect(statuses.has("failed")).toBe(true);
  });

  test("9. REST: filter execution logs by status", async () => {
    const result = await getExecutions("status=failed");

    const data = (result as Record<string, unknown>).data as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;
    for (const item of items) {
      expect(item.status).toBe("failed");
    }
  });

  test("10. REST: get single execution log entry", async () => {
    // Get the list first, then fetch a single entry
    const listResult = await getExecutions();
    const listData = (listResult as Record<string, unknown>).data as Record<string, unknown>;
    const items = listData.items as Array<Record<string, unknown>>;
    const firstId = items[0].id as string;

    const res = await fetch(`${BASE}/api/executions/${firstId}`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.success).toBe(true);
    const entry = body.data as Record<string, unknown>;
    expect(entry.id).toBe(firstId);
    expect(entry.action).toBeDefined();
    expect(entry.actor).toBeDefined();
    expect(entry.status).toBeDefined();
  });

  test("11. REST: 404 for non-existent execution", async () => {
    const res = await fetch(`${BASE}/api/executions/nonexistent_id`);
    expect(res.status).toBe(404);
  });

  test("12. GraphQL: query execution logs", async () => {
    const result = await graphql(`{
			executionLogs(pageSize: 5) {
				items {
					id action status
					actor { id type }
					duration startedAt
				}
				total
			}
		}`);

    expect(result.errors).toBeUndefined();
    const logs = (result.data as Record<string, unknown>).executionLogs as Record<string, unknown>;
    expect(logs.total as number).toBeGreaterThanOrEqual(3);

    const items = logs.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);

    // Verify entry structure
    const entry = items[0];
    expect(entry.id).toBeDefined();
    expect(entry.action).toBeDefined();
    expect(entry.status).toBeDefined();
    expect(entry.actor).toBeDefined();
    expect(entry.startedAt).toBeDefined();
  });

  test("13. GraphQL: query single execution log", async () => {
    // Get an ID first
    const listResult = await getExecutions();
    const listData = (listResult as Record<string, unknown>).data as Record<string, unknown>;
    const items = listData.items as Array<Record<string, unknown>>;
    const firstId = items[0].id as string;

    const result = await graphql(`{
			executionLog(id: "${firstId}") {
				id action status duration
			}
		}`);

    expect(result.errors).toBeUndefined();
    const entry = (result.data as Record<string, unknown>).executionLog as Record<string, unknown>;
    expect(entry.id).toBe(firstId);
  });
});

describe("E2E: Error scenarios", () => {
  test("14. Action on non-existent record → 404", async () => {
    const { status } = await restAction("submit_purchase_request", {
      id: "non_existent_pr_999",
    });
    expect(status).toBe(404);
  });

  test("15. Non-existent action → 404", async () => {
    const { status, body } = await restAction("totally_fake_action", {});
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test("16. Delete record then verify via GraphQL", async () => {
    // Create then delete
    const { body: createBody } = await restAction("create_purchase_request", {
      title: "To Be Deleted",
      amount: 1,
    });
    const deleteId = (createBody.data as Record<string, unknown>).id as string;

    const { status } = await restAction("delete_purchase_request", { id: deleteId });
    expect(status).toBe(200);

    // Verify deleted via GraphQL
    const result = await graphql(`{
			purchaseRequest(id: "${deleteId}") { id }
		}`);
    const data = (result.data as Record<string, unknown>).purchaseRequest;
    expect(data).toBeNull();
  });
});
