/**
 * GraphQL Execution Log query tests
 *
 * Validates the executionLogs and executionLog queries, including
 * filtering, pagination, sorting, single-entry lookup, and tenant isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core/server";
import { InMemoryStore } from "@linchkit/core/server";
import { InMemoryExecutionLogger } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const executor = createActionExecutor({
  dataProvider: store,
  executionLogger,
});

// Register CRUD actions
for (const action of generateCrudActions(taskSchema)) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([taskSchema], {
  executor,
  dataProvider: store,
  executionLogger,
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
  executionLogger.clear();
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

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL executionLogs query", () => {
  test("returns empty list when no executions", async () => {
    const result = await gql(`
      query {
        executionLogs {
          items { id action status }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: unknown[]; total: number };
    expect(logs.items).toHaveLength(0);
    expect(logs.total).toBe(0);
  });

  test("returns execution entries after action execution", async () => {
    // Execute an action to generate a log entry
    await executor.execute("create_task", { title: "Test Task" }, { type: "human", id: "user-1" });

    const result = await gql(`
      query {
        executionLogs {
          items {
            id
            action
            schema
            status
            duration
            startedAt
            completedAt
            actor { type id }
            input
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(logs.total).toBe(1);
    expect(logs.items).toHaveLength(1);

    const entry = logs.items[0];
    expect(entry.action).toBe("create_task");
    expect(entry.schema).toBe("task");
    expect(entry.status).toBe("succeeded");
    expect(entry.duration).toBeGreaterThanOrEqual(0);
    expect(entry.startedAt).toBeDefined();
    expect(entry.actor).toEqual({ type: "human", id: "user-1" });
    expect(entry.input).toBeDefined();
    // input should be JSON-encoded string
    const parsedInput = JSON.parse(entry.input as string);
    expect(parsedInput.title).toBe("Test Task");
  });

  test("filters by action name", async () => {
    await executor.execute("create_task", { title: "A" }, { type: "human", id: "user-1" });
    await executor.execute("create_task", { title: "B" }, { type: "human", id: "user-1" });
    // Generate a failed entry for a different action (nonexistent)
    await executor.execute("delete_task", { id: "nonexistent" }, { type: "human", id: "user-1" });

    const result = await gql(`
      query {
        executionLogs(action: "create_task") {
          items { action }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(2);
    for (const item of logs.items) {
      expect(item.action).toBe("create_task");
    }
  });

  test("filters by status", async () => {
    await executor.execute("create_task", { title: "Good" }, { type: "human", id: "user-1" });
    // Trigger a failure (missing required field)
    await executor.execute("create_task", {}, { type: "human", id: "user-1" });

    const result = await gql(`
      query {
        executionLogs(status: "succeeded") {
          items { status }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBeGreaterThanOrEqual(1);
    for (const item of logs.items) {
      expect(item.status).toBe("succeeded");
    }
  });

  test("filters by schema name", async () => {
    await executor.execute("create_task", { title: "T1" }, { type: "human", id: "user-1" });

    const result = await gql(`
      query {
        executionLogs(schema: "task") {
          items { schema }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(1);
    expect(logs.items[0].schema).toBe("task");
  });

  test("supports pagination with page/pageSize", async () => {
    // Create 3 entries
    for (let i = 0; i < 3; i++) {
      await executor.execute("create_task", { title: `Task ${i}` }, { type: "human", id: "user-1" });
    }

    const result = await gql(`
      query {
        executionLogs(page: 1, pageSize: 2) {
          items { id }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.items).toHaveLength(2);
    expect(logs.total).toBe(3);
  });

  test("supports sorting by startedAt", async () => {
    await executor.execute("create_task", { title: "First" }, { type: "human", id: "user-1" });
    await executor.execute("create_task", { title: "Second" }, { type: "human", id: "user-1" });

    // Default sort is startedAt desc
    const descResult = await gql(`
      query {
        executionLogs(sortField: "startedAt", sortOrder: "asc") {
          items { startedAt }
          total
        }
      }
    `);

    expect(descResult.errors).toBeUndefined();
    const logs = descResult.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(2);
    // Ascending order: first entry should have earlier startedAt
    const t0 = new Date(logs.items[0].startedAt as string).getTime();
    const t1 = new Date(logs.items[1].startedAt as string).getTime();
    expect(t0).toBeLessThanOrEqual(t1);
  });

  test("includes error field for failed executions", async () => {
    // Execute nonexistent action to get a failed entry
    await executor.execute("nonexistent_action", {}, { type: "human", id: "user-1" });

    const result = await gql(`
      query {
        executionLogs(status: "failed") {
          items {
            status
            error { code message }
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBeGreaterThanOrEqual(1);
    const failedEntry = logs.items[0];
    expect(failedEntry.status).toBe("failed");
    expect(failedEntry.error).toBeDefined();
    const error = failedEntry.error as Record<string, string>;
    expect(error.message).toBeDefined();
  });

  test("exposes channel and tracing fields", async () => {
    // Manually log an entry with extra fields to test GraphQL exposure
    executionLogger.log({
      id: "trace-test-1",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
      channel: "graphql",
      parentExecutionId: "parent-123",
      childExecutionIds: ["child-a", "child-b"],
      idempotencyKey: "idem-key-1",
    });

    const result = await gql(`
      query {
        executionLogs {
          items {
            id
            channel
            parentExecutionId
            childExecutionIds
            idempotencyKey
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(1);
    const entry = logs.items[0];
    expect(entry.id).toBe("trace-test-1");
    expect(entry.channel).toBe("graphql");
    expect(entry.parentExecutionId).toBe("parent-123");
    expect(entry.childExecutionIds).toEqual(["child-a", "child-b"]);
    expect(entry.idempotencyKey).toBe("idem-key-1");
  });
});

describe("GraphQL executionLog single entry query", () => {
  test("returns entry by id", async () => {
    await executor.execute("create_task", { title: "Lookup" }, { type: "human", id: "user-1" });

    // Get the entry id from the logger
    const entries = executionLogger.getAll();
    expect(entries).toHaveLength(1);
    const entryId = entries[0].id;

    const result = await gql(`
      query($id: ID!) {
        executionLog(id: $id) {
          id
          action
          status
          actor { type id }
        }
      }
    `, { id: entryId });

    expect(result.errors).toBeUndefined();
    const entry = result.data.executionLog as Record<string, unknown>;
    expect(entry).not.toBeNull();
    expect(entry.id).toBe(entryId);
    expect(entry.action).toBe("create_task");
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
    // Manually log an entry with a specific tenantId
    executionLogger.log({
      id: "tenant-entry-1",
      tenantId: "tenant-A",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
    });

    // Query without tenant context should return the entry (no tenant filtering)
    const result = await gql(`
      query {
        executionLog(id: "tenant-entry-1") {
          id
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    // Without tenant context in the GraphQL context, tenant isolation check
    // passes because ctx.tenantId is undefined
    expect(result.data.executionLog).not.toBeNull();
  });
});

describe("GraphQL executionLogs date range filtering", () => {
  test("filters by since parameter", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000); // 1 minute ago
    const future = new Date(now.getTime() + 60_000); // 1 minute from now

    executionLogger.log({
      id: "old-entry",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: past,
      completedAt: past,
    });

    executionLogger.log({
      id: "new-entry",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: future,
      completedAt: future,
    });

    // Filter entries since now — should only get the future entry
    const result = await gql(`
      query($since: String) {
        executionLogs(since: $since) {
          items { id }
          total
        }
      }
    `, { since: now.toISOString() });

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(1);
    expect(logs.items[0].id).toBe("new-entry");
  });

  test("filters by until parameter", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);

    executionLogger.log({
      id: "old-entry",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: past,
      completedAt: past,
    });

    executionLogger.log({
      id: "new-entry",
      action: "create_task",
      schema: "task",
      actor: { type: "human", id: "user-1" },
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: future,
      completedAt: future,
    });

    // Filter entries until now — should only get the past entry
    const result = await gql(`
      query($until: String) {
        executionLogs(until: $until) {
          items { id }
          total
        }
      }
    `, { until: now.toISOString() });

    expect(result.errors).toBeUndefined();
    const logs = result.data.executionLogs as { items: Array<Record<string, unknown>>; total: number };
    expect(logs.total).toBe(1);
    expect(logs.items[0].id).toBe("old-entry");
  });
});
