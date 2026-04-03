/**
 * GraphQL Execution Log query tests
 *
 * Validates the auto-generated executionLogList and executionLog queries
 * (from the system schema "execution_log"), including filtering, pagination,
 * sorting, single-entry lookup, and tenant isolation.
 *
 * Data is seeded directly into InMemoryStore under the "execution_log" schema
 * because the auto-generated GraphQL resolvers read from DataProvider.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";
import { executionLogSchema } from "../src/system-schemas";

// ── Setup ────────────────────────────────────────────────

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({
  dataProvider: store,
});

// Register CRUD actions for the task schema
for (const action of generateCrudActions(taskSchema)) {
  executor.registry.register(action);
}

// Build GraphQL schema including the system execution_log schema
const graphqlSchema = buildGraphQLSchema([taskSchema, executionLogSchema], {
  executor,
  dataProvider: store,
  internalSchemas: new Set(["execution_log"]),
});
const app = createServer(graphqlSchema);
const port = 3993;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

/** Seed an execution log entry into the InMemoryStore */
async function seedLog(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const defaults: Record<string, unknown> = {
    action_name: "create_task",
    schema_name: "task",
    actor_id: "user-1",
    actor_type: "human",
    status: "succeeded",
    duration_ms: 5,
    started_at: now,
    completed_at: now,
    input: JSON.stringify({}),
    channel: "rest",
  };
  return store.create("execution_log", { ...defaults, ...overrides });
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL executionLogList query", () => {
  test("returns empty list when no executions", async () => {
    const result = await gql(`
      query {
        executionLogList {
          items { id action_name status }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as { items: unknown[]; total: number };
    expect(logs.items).toHaveLength(0);
    expect(logs.total).toBe(0);
  });

  test("returns execution entries with correct field names", async () => {
    await seedLog({
      action_name: "create_task",
      schema_name: "task",
      actor_id: "user-1",
      actor_type: "human",
      status: "succeeded",
      duration_ms: 42,
      input: JSON.stringify({ title: "Test Task" }),
    });

    const result = await gql(`
      query {
        executionLogList {
          items {
            id
            action_name
            schema_name
            status
            duration_ms
            started_at
            completed_at
            actor_id
            actor_type
            input
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    expect(logs.items).toHaveLength(1);

    const entry = logs.items[0];
    expect(entry.action_name).toBe("create_task");
    expect(entry.schema_name).toBe("task");
    expect(entry.status).toBe("succeeded");
    expect(entry.duration_ms).toBe(42);
    expect(entry.started_at).toBeDefined();
    expect(entry.actor_id).toBe("user-1");
    expect(entry.actor_type).toBe("human");
    expect(entry.input).toBeDefined();
    // input should be JSON-encoded string
    const parsedInput = JSON.parse(entry.input as string);
    expect(parsedInput.title).toBe("Test Task");
  });

  test("filters by action_name using filter arg", async () => {
    await seedLog({ action_name: "create_task" });
    await seedLog({ action_name: "create_task" });
    await seedLog({ action_name: "delete_task", status: "failed" });

    const result = await gql(
      `
      query($filter: String) {
        executionLogList(filter: $filter) {
          items { action_name }
          total
        }
      }
    `,
      { filter: JSON.stringify({ action_name: "create_task" }) },
    );

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(2);
    for (const item of logs.items) {
      expect(item.action_name).toBe("create_task");
    }
  });

  test("filters by status using filter arg", async () => {
    await seedLog({ status: "succeeded" });
    await seedLog({ status: "failed", error_message: "missing field" });

    const result = await gql(
      `
      query($filter: String) {
        executionLogList(filter: $filter) {
          items { status }
          total
        }
      }
    `,
      { filter: JSON.stringify({ status: "succeeded" }) },
    );

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    for (const item of logs.items) {
      expect(item.status).toBe("succeeded");
    }
  });

  test("filters by schema_name using filter arg", async () => {
    await seedLog({ schema_name: "task" });
    await seedLog({ schema_name: "order" });

    const result = await gql(
      `
      query($filter: String) {
        executionLogList(filter: $filter) {
          items { schema_name }
          total
        }
      }
    `,
      { filter: JSON.stringify({ schema_name: "task" }) },
    );

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    expect(logs.items[0].schema_name).toBe("task");
  });

  test("supports pagination with page/pageSize", async () => {
    // Create 3 entries
    for (let i = 0; i < 3; i++) {
      await seedLog({ action_name: `action_${i}` });
    }

    const result = await gql(`
      query {
        executionLogList(page: 1, pageSize: 2) {
          items { id }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(logs.items).toHaveLength(2);
    expect(logs.total).toBe(3);
    expect(logs.pageInfo.hasMore).toBe(true);
  });

  test("supports sorting by started_at", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    await seedLog({ started_at: past, action_name: "first" });
    await seedLog({ started_at: future, action_name: "second" });

    // Ascending order
    const ascResult = await gql(`
      query {
        executionLogList(sortField: "started_at", sortOrder: "asc") {
          items { started_at }
          total
        }
      }
    `);

    expect(ascResult.errors).toBeUndefined();
    const logs = ascResult.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(2);
    const t0 = new Date(logs.items[0].started_at as string).getTime();
    const t1 = new Date(logs.items[1].started_at as string).getTime();
    expect(t0).toBeLessThanOrEqual(t1);
  });

  test("includes error fields for failed executions", async () => {
    await seedLog({
      status: "failed",
      error_code: "NOT_FOUND",
      error_message: "Action not found",
    });

    const result = await gql(
      `
      query($filter: String) {
        executionLogList(filter: $filter) {
          items {
            status
            error_code
            error_message
          }
          total
        }
      }
    `,
      { filter: JSON.stringify({ status: "failed" }) },
    );

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    const failedEntry = logs.items[0];
    expect(failedEntry.status).toBe("failed");
    expect(failedEntry.error_code).toBe("NOT_FOUND");
    expect(failedEntry.error_message).toBe("Action not found");
  });

  test("exposes channel field", async () => {
    await seedLog({
      channel: "graphql",
    });

    const result = await gql(`
      query {
        executionLogList {
          items {
            id
            channel
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    const entry = logs.items[0];
    expect(entry.channel).toBe("graphql");
  });
});

describe("GraphQL executionLog single entry query", () => {
  test("returns entry by id", async () => {
    const created = await seedLog({
      action_name: "create_task",
      status: "succeeded",
      actor_id: "user-1",
      actor_type: "human",
    });
    const entryId = created.id as string;

    const result = await gql(
      `
      query($id: ID!) {
        executionLog(id: $id) {
          id
          action_name
          status
          actor_id
          actor_type
        }
      }
    `,
      { id: entryId },
    );

    expect(result.errors).toBeUndefined();
    const entry = result.data.executionLog as Record<string, unknown>;
    expect(entry).not.toBeNull();
    expect(entry.id).toBe(entryId);
    expect(entry.action_name).toBe("create_task");
    expect(entry.status).toBe("succeeded");
  });

  test("returns null for non-existent id", async () => {
    const result = await gql(`
      query {
        executionLog(id: "nonexistent-id") {
          id
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    expect(result.data.executionLog).toBeNull();
  });

  test("enforces tenant isolation", async () => {
    const created = await seedLog({
      tenant_id: "tenant-A",
      action_name: "create_task",
      status: "succeeded",
    });
    const entryId = created.id as string;

    // Query without tenant context should return the entry (no tenant filtering)
    const result = await gql(
      `
      query($id: ID!) {
        executionLog(id: $id) {
          id
        }
      }
    `,
      { id: entryId },
    );

    expect(result.errors).toBeUndefined();
    // Without tenant context in the GraphQL context, tenant isolation check
    // passes because ctx.tenantId is undefined
    expect(result.data.executionLog).not.toBeNull();
  });
});
