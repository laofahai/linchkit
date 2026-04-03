import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    priority: { type: "number", label: "Priority" },
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

for (const action of generateCrudActions(taskSchema)) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([taskSchema], { executor, dataProvider: store });
const app = createServer(graphqlSchema);
const port = 3987;

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

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL pagination metadata", () => {
  test("pageInfo includes limit, offset, and hasMore", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });
    await store.create("task", { id: "t2", title: "Task 2", priority: 2 });
    await store.create("task", { id: "t3", title: "Task 3", priority: 3 });

    const result = await gql(`
      query {
        taskList(pageSize: 2) {
          items { id }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(list.total).toBe(3);
    expect(list.items).toHaveLength(2);
    expect(list.pageInfo.limit).toBe(2);
    expect(list.pageInfo.offset).toBe(0);
    expect(list.pageInfo.hasMore).toBe(true);
  });

  test("hasMore is false when all records fit in one page", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });
    await store.create("task", { id: "t2", title: "Task 2", priority: 2 });

    const result = await gql(`
      query {
        taskList(pageSize: 10) {
          items { id }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(2);
    expect(list.pageInfo.limit).toBe(10);
    expect(list.pageInfo.offset).toBe(0);
    expect(list.pageInfo.hasMore).toBe(false);
  });

  test("hasMore is false on the last page", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });
    await store.create("task", { id: "t2", title: "Task 2", priority: 2 });
    await store.create("task", { id: "t3", title: "Task 3", priority: 3 });

    // Page 2 with pageSize 2 => offset=2, only 1 item left
    const result = await gql(`
      query {
        taskList(page: 2, pageSize: 2) {
          items { id }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(list.total).toBe(3);
    expect(list.items).toHaveLength(1);
    expect(list.pageInfo.limit).toBe(2);
    expect(list.pageInfo.offset).toBe(2);
    expect(list.pageInfo.hasMore).toBe(false);
  });

  test("empty result has correct pageInfo", async () => {
    const result = await gql(`
      query {
        taskList {
          items { id }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(list.total).toBe(0);
    expect(list.items).toHaveLength(0);
    expect(list.pageInfo.limit).toBe(20); // default pageSize
    expect(list.pageInfo.offset).toBe(0);
    expect(list.pageInfo.hasMore).toBe(false);
  });
});

describe("GraphQL sort arguments", () => {
  test("default sort is created_at DESC (newest first)", async () => {
    // Create records with deterministic created_at ordering
    // InMemoryStore uses Date.now() for created_at, so we seed with explicit timestamps
    store.seed("task", [
      { id: "old", title: "Old Task", priority: 1, created_at: "2025-01-01T00:00:00.000Z" },
      { id: "mid", title: "Mid Task", priority: 2, created_at: "2025-06-01T00:00:00.000Z" },
      { id: "new", title: "New Task", priority: 3, created_at: "2025-12-01T00:00:00.000Z" },
    ]);

    const result = await gql(`
      query {
        taskList {
          items { id title }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list.items).toHaveLength(3);
    // Default sort: created_at DESC — newest first
    expect(list.items[0].id).toBe("new");
    expect(list.items[1].id).toBe("mid");
    expect(list.items[2].id).toBe("old");
  });

  test("sortField=title sortOrder=asc sorts alphabetically", async () => {
    store.seed("task", [
      { id: "c", title: "Charlie", priority: 1 },
      { id: "a", title: "Alpha", priority: 2 },
      { id: "b", title: "Bravo", priority: 3 },
    ]);

    const result = await gql(`
      query {
        taskList(sortField: "title", sortOrder: "asc") {
          items { id title }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list.items).toHaveLength(3);
    expect(list.items[0].title).toBe("Alpha");
    expect(list.items[1].title).toBe("Bravo");
    expect(list.items[2].title).toBe("Charlie");
  });

  test("sortField=priority sortOrder=desc sorts descending", async () => {
    store.seed("task", [
      { id: "low", title: "Low", priority: 1 },
      { id: "high", title: "High", priority: 10 },
      { id: "med", title: "Med", priority: 5 },
    ]);

    const result = await gql(`
      query {
        taskList(sortField: "priority", sortOrder: "desc") {
          items { id priority }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list.items).toHaveLength(3);
    expect(list.items[0].priority).toBe(10);
    expect(list.items[1].priority).toBe(5);
    expect(list.items[2].priority).toBe(1);
  });

  test("sort combined with pagination returns correct page", async () => {
    store.seed("task", [
      { id: "a", title: "Alpha", priority: 1 },
      { id: "b", title: "Bravo", priority: 2 },
      { id: "c", title: "Charlie", priority: 3 },
      { id: "d", title: "Delta", priority: 4 },
      { id: "e", title: "Echo", priority: 5 },
    ]);

    const result = await gql(`
      query {
        taskList(sortField: "priority", sortOrder: "asc", page: 2, pageSize: 2) {
          items { id priority }
          total
          pageInfo { limit offset hasMore }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
      pageInfo: { limit: number; offset: number; hasMore: boolean };
    };
    expect(list.total).toBe(5);
    expect(list.items).toHaveLength(2);
    // Page 2 with sort by priority asc: items 3 and 4
    expect(list.items[0].priority).toBe(3);
    expect(list.items[1].priority).toBe(4);
    expect(list.pageInfo.hasMore).toBe(true);
    expect(list.pageInfo.offset).toBe(2);
  });
});
