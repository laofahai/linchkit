/**
 * E2E Test: Auth + Permission flow
 *
 * Validates authentication and authorization through the CommandLayer:
 * - Unauthenticated request → 401
 * - Authenticated request → success
 * - Unauthorized action → 403
 *
 * Uses InMemoryStore with CommandLayer middleware for auth/permission checks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, Actor, EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ────────────────────────────────────────────────

const orderSchema: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", label: "Amount" },
  },
};

// ── Actions ──────────────────────────────────────────────

/** A public action anyone can call */
const publicAction: ActionDefinition = {
  name: "health_check",
  entity: "system",
  label: "Health Check",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async () => ({ status: "ok" }),
};

/** An action restricted to the "manager" group */
const managerAction: ActionDefinition = {
  name: "approve_order",
  entity: "order",
  label: "Approve Order",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  permissions: {
    groups: ["manager"],
  },
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    return { approved: true, orderId: id };
  },
};

/** An action restricted to the "admin" group */
const adminAction: ActionDefinition = {
  name: "delete_all_orders",
  entity: "order",
  label: "Delete All Orders",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  permissions: {
    groups: ["admin"],
  },
  handler: async () => ({ deleted: true }),
};

/** An action that is internal only (not exposed over HTTP) */
const internalAction: ActionDefinition = {
  name: "internal_cleanup",
  entity: "order",
  label: "Internal Cleanup",
  policy: { mode: "sync", transaction: false },
  exposure: { http: false, internal: true },
  handler: async () => ({ cleaned: true }),
};

// ── Setup ────────────────────────────────────────────────

const PORT = 32150;
const REST_URL = `http://localhost:${PORT}/api/actions`;
const GQL_URL = `http://localhost:${PORT}/graphql`;

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  const executionLogger = new InMemoryExecutionLogger();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger,
  });

  // Register all actions
  for (const action of generateCrudActions(orderSchema)) {
    executor.registry.register(action);
  }
  executor.registry.register(publicAction);
  executor.registry.register(managerAction);
  executor.registry.register(adminAction);
  executor.registry.register(internalAction);

  const graphqlSchema = buildGraphQLSchema([orderSchema], {
    executor,
    dataProvider: store,
    executionLogger,
  });

  // Configure server with actor resolver that simulates auth
  app = createServer(graphqlSchema, {
    executor,
    executionLogger,
    dataProvider: store,
    resolveRequestActor: async (request: Request): Promise<Actor | undefined> => {
      const authHeader = request.headers.get("authorization");
      if (!authHeader) {
        return undefined; // No auth → anonymous actor (default)
      }
      if (authHeader === "Bearer valid-user-token") {
        return { type: "human", id: "user-1", groups: ["employee"] };
      }
      if (authHeader === "Bearer valid-manager-token") {
        return { type: "human", id: "manager-1", groups: ["employee", "manager"] };
      }
      if (authHeader === "Bearer valid-admin-token") {
        return { type: "human", id: "admin-1", groups: ["employee", "manager", "admin"] };
      }
      return undefined;
    },
  });
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helpers ────────────────────────────────────────────────

async function restAction(
  name: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${REST_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("E2E auth + permission flow", () => {
  test("1. Unauthenticated request to restricted action → 403 (permission denied)", async () => {
    // No Authorization header → anonymous actor → no groups → permission denied
    const { status, body } = await restAction("approve_order", { id: "order_1" });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("does not belong to");
  });

  test("2. Authenticated user without required group → 403", async () => {
    // User has "employee" group but action requires "manager"
    const { status, body } = await restAction(
      "approve_order",
      { id: "order_1" },
      { Authorization: "Bearer valid-user-token" },
    );

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test("3. Authenticated manager → success", async () => {
    // Manager has "employee" and "manager" groups
    const { status, body } = await restAction(
      "approve_order",
      { id: "order_1" },
      { Authorization: "Bearer valid-manager-token" },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.approved).toBe(true);
  });

  test("4. Admin can also perform manager actions", async () => {
    const { status, body } = await restAction(
      "approve_order",
      { id: "order_1" },
      { Authorization: "Bearer valid-admin-token" },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("5. Admin-only action denied for manager", async () => {
    const { status, body } = await restAction(
      "delete_all_orders",
      {},
      { Authorization: "Bearer valid-manager-token" },
    );

    // Manager does not have "admin" group
    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test("6. Admin-only action succeeds for admin", async () => {
    const { status, body } = await restAction(
      "delete_all_orders",
      {},
      { Authorization: "Bearer valid-admin-token" },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.deleted).toBe(true);
  });

  test("7. Internal action (not exposed over HTTP) → 403", async () => {
    const { status, body } = await restAction(
      "internal_cleanup",
      {},
      { Authorization: "Bearer valid-admin-token" },
    );

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("not exposed");
  });

  test("8. Non-existent action → 404", async () => {
    const { status, body } = await restAction(
      "totally_fake_action",
      {},
      { Authorization: "Bearer valid-admin-token" },
    );

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test("9. CRUD actions work for unauthenticated (no group restriction)", async () => {
    // Create is a CRUD action with no group restriction
    const createResult = await restAction("create_order", { title: "Test Order", amount: 100 });
    expect(createResult.status).toBe(200);
    expect(createResult.body.success).toBe(true);

    const data = createResult.body.data as Record<string, unknown>;
    expect(data.title).toBe("Test Order");
    expect(data.id).toBeDefined();
  });

  test("10. GraphQL queries work regardless of auth (no query-level restrictions)", async () => {
    // Seed data
    await store.create("order", { id: "ord_1", title: "GraphQL Test", amount: 999 });

    // Query without auth header
    const result = await gql(`
      query { order(id: "ord_1") { id title amount } }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.order as Record<string, unknown>;
    expect(order.title).toBe("GraphQL Test");
    expect(order.amount).toBe(999);
  });

  test("11. GraphQL mutations with auth context", async () => {
    // Create order via GraphQL
    const result = await gql(
      `
      mutation {
        createOrder(input: { title: "Auth Order", amount: 500 }) {
          id title amount _version
        }
      }
    `,
      { Authorization: "Bearer valid-user-token" },
    );

    expect(result.errors).toBeUndefined();
    const order = result.data.createOrder as Record<string, unknown>;
    expect(order.title).toBe("Auth Order");
    expect(order._version).toBe(1);
  });

  test("12. Health endpoint always accessible", async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });
});
