import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { approveAction, purchaseRequestEntity, submitAction } from "@linchkit/cap-purchase-demo";
import {
  createActionExecutor,
  InMemoryExecutionLogger,
  InMemoryStore,
  EntityRegistry,
} from "@linchkit/core/server";
import {
  buildGraphQLSchema,
  generateCrudActions,
} from "../addons/adapter-server/cap-adapter-server/src/graphql/build-schema";
import { createServer } from "../addons/adapter-server/cap-adapter-server/src/server";

// Strip permission restrictions for E2E testing with anonymous actor
const e2eSubmitAction = { ...submitAction, permissions: undefined };
const e2eApproveAction = { ...approveAction, permissions: undefined };

// ── Setup: in-process server (no subprocess spawn) ───────
const PORT = 4021;
const BASE = `http://localhost:${PORT}`;

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const entityRegistry = new EntityRegistry();
entityRegistry.register(purchaseRequestEntity);

const executor = createActionExecutor({ dataProvider: store, executionLogger });
const allActions = [
  ...generateCrudActions(purchaseRequestEntity),
  e2eSubmitAction,
  e2eApproveAction,
];
for (const action of allActions) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([purchaseRequestEntity], {
  executor,
  dataProvider: store,
  actions: [e2eSubmitAction, e2eApproveAction],
});

const app = createServer(graphqlSchema, {
  executor,
  executionLogger,
  entityRegistry,
});

// ── Helper functions ─────────────────────────────────────
async function executeActionReq(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  }>;
}

async function fetchSchemas() {
  const res = await fetch(`${BASE}/api/entities`);
  const json = (await res.json()) as { success: boolean; data: { name: string; label: string }[] };
  return json.data;
}

async function gql<T = unknown>(query: string): Promise<T> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0]?.message}`);
  }
  return json.data as T;
}

// ── Lifecycle ────────────────────────────────────────────
describe("Purchase Request E2E Flow", () => {
  beforeAll(() => {
    app.listen(PORT);
  });

  afterAll(() => {
    app.stop();
  });

  test("server health check", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("healthy");
  });

  test("schemas API returns purchase_request", async () => {
    const schemas = await fetchSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(1);
    expect(schemas.some((s) => s.name === "purchase_request")).toBe(true);
  });

  test("GraphQL introspection works", async () => {
    const data = await gql<{
      __schema: { queryType: { fields: { name: string }[] } };
    }>("{ __schema { queryType { fields { name } } } }");
    const fieldNames = data.__schema.queryType.fields.map((f) => f.name);
    expect(fieldNames).toContain("purchaseRequestList");
  });

  let createdId: string;

  test("create purchase request", async () => {
    const result = await executeActionReq("create_purchase_request", {
      title: "E2E Test Request",
      amount: 5000,
      priority: "high",
      department: "Engineering",
      requester: "e2e-tester",
    });
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    createdId = result.data?.id as string;
    expect(createdId).toBeTruthy();
    // Verify default state was injected
    expect(result.data?.status).toBe("draft");
  });

  test("submit purchase request", async () => {
    const result = await executeActionReq("submit_purchase_request", {
      id: createdId,
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("pending");
  });

  test("approve purchase request", async () => {
    const result = await executeActionReq("approve_purchase_request", {
      id: createdId,
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("approved");
  });

  test("verify final state via GraphQL", async () => {
    const data = await gql<{
      purchaseRequest: { id: string; status: string };
    }>(`{ purchaseRequest(id: "${createdId}") { id status } }`);
    expect(data.purchaseRequest.status).toBe("approved");
  });
});
