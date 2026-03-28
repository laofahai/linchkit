/**
 * E2E test: Flow execution via REST API
 *
 * Tests the full HTTP chain:
 *   1. Create purchase request via REST
 *   2. Submit via REST (draft → pending)
 *   3. Trigger flow via POST /api/flows/:name/start
 *   4. Query flow status via GET /api/flows/:name/status/:instanceId
 *   5. Verify final state via GraphQL
 *   6. Auto-trigger: action.succeeded → TriggerBinding → flow starts automatically
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createEventBus,
  createFlowStepContext,
  createSyncFlowEngine,
  createTriggerBinding,
  InMemoryExecutionLogger,
  InMemoryStore,
  SchemaRegistry,
} from "@linchkit/core/server";
import { purchaseApprovalFlow } from "../../cap-purchase-demo/src/flows/purchase-approval";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ──────────────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    requester: { type: "string", label: "Requester" },
    status: { type: "state", machine: "purchase_lifecycle", default: "draft" },
    approved_by: { type: "string", label: "Approved By" },
    audit_notes: { type: "text", label: "Audit Notes" },
  },
};

// ── Actions (no permission checks — test only) ─────────

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
      throw new Error(`Cannot submit: status is "${record.status}", expected "draft"`);
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
      throw new Error(`Cannot approve: status is "${record.status}", expected "pending"`);
    }
    return ctx.update("purchase_request", id, {
      status: "approved",
      approved_by: ctx.actor?.id ?? "system:auto-approval",
    });
  },
};

// ── Setup: wire real runtime ────────────────────────────

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const schemaRegistry = new SchemaRegistry();
schemaRegistry.register(purchaseRequestSchema);

const { bus: eventBus } = createEventBus();
const executor = createActionExecutor({ dataProvider: store, executionLogger, eventBus });

const allActions = [...generateCrudActions(purchaseRequestSchema), submitAction, approveAction];
for (const action of allActions) {
  executor.registry.register(action);
}

// Flow engine with real action execution through executor
const flowStepContext = createFlowStepContext({
  actionEngine: {
    execute: (actionName, input, options) => {
      const actor = options?.actor ?? { type: "system" as const, id: "flow-engine", groups: [] };
      return executor.execute(actionName, input, actor, {
        tenantId: options?.tenantId,
        channel: "internal",
      });
    },
  },
});
const flowEngine = createSyncFlowEngine(flowStepContext);
flowEngine.registerFlow(purchaseApprovalFlow);

// TriggerBinding created on demand — only bind in auto-trigger tests
// to avoid interfering with manual-trigger tests
const triggerBinding = createTriggerBinding(eventBus);

// GraphQL schema
const graphqlSchema = buildGraphQLSchema([purchaseRequestSchema], {
  executor,
  dataProvider: store,
  actions: [submitAction, approveAction],
  executionLogger,
});

// Server with flowEngine
const app = createServer(graphqlSchema, {
  executor,
  executionLogger,
  schemaRegistry,
  flows: [purchaseApprovalFlow],
  flowEngine,
});

const PORT = 4030;
const BASE = `http://localhost:${PORT}`;

// ── Helpers ─────────────────────────────────────────────

async function restAction(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(query: string) {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function startFlow(flowName: string, input: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/flows/${flowName}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function flowStatus(flowName: string, instanceId: string) {
  const res = await fetch(`${BASE}/api/flows/${flowName}/status/${instanceId}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── Lifecycle ───────────────────────────────────────────

beforeAll(() => {
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

// ── Tests ───────────────────────────────────────────────

describe("Flow REST API — list and detail", () => {
  test("GET /api/flows lists registered flows", async () => {
    const res = await fetch(`${BASE}/api/flows`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    const flows = body.data as Array<Record<string, unknown>>;
    expect(flows).toHaveLength(1);
    expect(flows[0].name).toBe("purchase_approval");
    expect(flows[0].stepCount).toBe(3);
  });

  test("GET /api/flows/:name returns flow definition", async () => {
    const res = await fetch(`${BASE}/api/flows/purchase_approval`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    const flow = body.data as Record<string, unknown>;
    expect(flow.name).toBe("purchase_approval");
    expect((flow.steps as unknown[]).length).toBe(3);
  });

  test("GET /api/flows/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/api/flows/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("E2E: Small purchase — auto-approved by flow", () => {
  let purchaseId: string;

  test("1. Create purchase request (draft, amount=2000)", async () => {
    const { status, body } = await restAction("create_purchase_request", {
      title: "Office Supplies",
      amount: 2000,
      requester: "Alice",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    purchaseId = (body.data as Record<string, unknown>).id as string;
    expect(purchaseId).toBeDefined();
  });

  test("2. Submit → draft to pending", async () => {
    const { status, body } = await restAction("submit_purchase_request", {
      id: purchaseId,
    });
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).status).toBe("pending");
  });

  test("3. Trigger flow via API → auto-approve (amount <= 5000)", async () => {
    const { status, body } = await startFlow("purchase_approval", {
      id: purchaseId,
      amount: 2000,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const instance = body.data as Record<string, unknown>;
    expect(instance.flowName).toBe("purchase_approval");
    expect(instance.status).toBe("completed");
  });

  test("4. Verify via GraphQL: status=approved", async () => {
    const result = await gql(`{
      purchaseRequest(id: "${purchaseId}") { id status approved_by }
    }`);
    const pr = (result.data as Record<string, unknown>).purchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("approved");
    expect(pr.approved_by).toBe("flow-engine");
  });
});

describe("E2E: Large purchase — flagged for manager", () => {
  let purchaseId: string;

  test("1. Create purchase request (draft, amount=30000)", async () => {
    const { body } = await restAction("create_purchase_request", {
      title: "Server Hardware",
      amount: 30000,
      requester: "Bob",
    });
    purchaseId = (body.data as Record<string, unknown>).id as string;
  });

  test("2. Submit → draft to pending", async () => {
    const { body } = await restAction("submit_purchase_request", {
      id: purchaseId,
    });
    expect((body.data as Record<string, unknown>).status).toBe("pending");
  });

  test("3. Trigger flow → flag for review (amount > 5000)", async () => {
    const { body } = await startFlow("purchase_approval", {
      id: purchaseId,
      amount: 30000,
    });
    const instance = body.data as Record<string, unknown>;
    expect(instance.status).toBe("completed");
  });

  test("4. Verify via GraphQL: still pending + audit note", async () => {
    const result = await gql(`{
      purchaseRequest(id: "${purchaseId}") { id status audit_notes }
    }`);
    const pr = (result.data as Record<string, unknown>).purchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("pending");
    expect(String(pr.audit_notes)).toContain("manager approval");
  });

  test("5. Manager approves manually via REST", async () => {
    const { status, body } = await restAction("approve_purchase_request", {
      id: purchaseId,
    });
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).status).toBe("approved");
  });
});

describe("Flow status tracking API", () => {
  test("query flow instance status after execution", async () => {
    // Create + submit a small purchase
    const { body: createBody } = await restAction("create_purchase_request", {
      title: "Status Test",
      amount: 100,
      requester: "Charlie",
    });
    const id = (createBody.data as Record<string, unknown>).id as string;
    await restAction("submit_purchase_request", { id });

    // Trigger flow
    const { body: flowBody } = await startFlow("purchase_approval", { id, amount: 100 });
    const instanceId = (flowBody.data as Record<string, unknown>).id as string;

    // Query status
    const { status, body } = await flowStatus("purchase_approval", instanceId);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const instance = body.data as Record<string, unknown>;
    expect(instance.status).toBe("completed");
    expect(instance.flowName).toBe("purchase_approval");
  });

  test("404 for non-existent instance", async () => {
    const { status } = await flowStatus("purchase_approval", "nonexistent-id");
    expect(status).toBe(404);
  });
});

describe("E2E: Auto-trigger — action.succeeded → TriggerBinding → flow", () => {
  test("submit action emits event → TriggerBinding starts flow → auto-approves", async () => {
    // Bind triggers just for this test
    triggerBinding.bindAll([purchaseApprovalFlow], flowEngine);
    // Create a purchase request
    const { body: createBody } = await restAction("create_purchase_request", {
      title: "Auto-trigger Test",
      amount: 1500,
      requester: "Eve",
    });
    const id = (createBody.data as Record<string, unknown>).id as string;

    // Submit — this emits "action.succeeded" → TriggerBinding → flow starts
    await restAction("submit_purchase_request", { id });

    // Wait for async event processing
    await new Promise((r) => setTimeout(r, 500));

    // Verify: flow should have auto-approved (amount 1500 <= 5000)
    const result = await gql(`{ purchaseRequest(id: "${id}") { status approved_by } }`);
    const pr = (result.data as Record<string, unknown>).purchaseRequest as Record<string, unknown>;
    expect(pr.status).toBe("approved");

    // Unbind triggers after test
    triggerBinding.unbindAll();
  });
});

describe("Flow error handling", () => {
  test("trigger with non-existent record → flow fails gracefully", async () => {
    const { status, body } = await startFlow("purchase_approval", {
      id: "ghost-record",
      amount: 100,
    });
    // Flow engine returns the instance, but status is "failed"
    expect(status).toBe(200);
    const instance = body.data as Record<string, unknown>;
    expect(instance.status).toBe("failed");
    expect(instance.error).toBeDefined();
  });

  test("trigger non-existent flow → 404", async () => {
    const { status } = await startFlow("fake_flow", {});
    expect(status).toBe(404);
  });
});
