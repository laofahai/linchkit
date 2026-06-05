import { beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import { CacheManager, createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const taskSchema: EntityDefinition = {
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

const cacheManager = new CacheManager();

const graphqlSchema = buildGraphQLSchema([taskSchema], {
  executor,
  dataProvider: store,
  cacheManager,
});

const app = createServer(graphqlSchema);
// In-process, port-free: this URL only supplies a path to `new Request(...)` for
// `app.handle` — no socket is bound, so a dummy domain is used (no real port).
const GQL_URL = "http://local.test/graphql";

beforeEach(() => {
  store.clear();
  cacheManager.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await app.handle(
    new Request(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL query cache", () => {
  test("list query returns cached result on second call", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });

    const result1 = await gql(`query { taskList { items { id title } total } }`);
    expect(result1.errors).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result1.data.taskList as any).total).toBe(1);

    // Cache stats should show a miss (first call)
    const stats1 = cacheManager.stats();
    expect(stats1.l1.misses).toBeGreaterThanOrEqual(1);

    // Second call should hit cache
    const result2 = await gql(`query { taskList { items { id title } total } }`);
    expect(result2.errors).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result2.data.taskList as any).total).toBe(1);

    const stats2 = cacheManager.stats();
    expect(stats2.l1.hits).toBeGreaterThanOrEqual(1);
  });

  test("get query returns cached result on second call", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });

    const query = `query { task(id: "t1") { id title } }`;
    const result1 = await gql(query);
    expect(result1.errors).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result1.data.task as any).title).toBe("Task 1");

    const stats1 = cacheManager.stats();
    const _missesAfterFirst = stats1.l1.misses;

    // Second call should hit cache
    const result2 = await gql(query);
    expect(result2.errors).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result2.data.task as any).title).toBe("Task 1");

    const stats2 = cacheManager.stats();
    expect(stats2.l1.hits).toBeGreaterThan(0);
  });

  test("create mutation invalidates list cache", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });

    // Warm up list cache
    const result1 = await gql(`query { taskList { total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result1.data.taskList as any).total).toBe(1);

    // Create a new task via mutation
    await gql(`mutation { createTask(input: { title: "Task 2", priority: 2 }) { id } }`);

    // List should reflect the new record (cache was invalidated)
    const result2 = await gql(`query { taskList { total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result2.data.taskList as any).total).toBe(2);
  });

  test("update mutation invalidates get cache", async () => {
    await store.create("task", { id: "t1", title: "Original", priority: 1 });

    // Warm up get cache
    const result1 = await gql(`query { task(id: "t1") { title } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result1.data.task as any).title).toBe("Original");

    // Update via mutation
    await gql(`mutation { updateTask(id: "t1", input: { title: "Updated" }) { id } }`);

    // Get should reflect the update (cache was invalidated)
    const result2 = await gql(`query { task(id: "t1") { title } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result2.data.task as any).title).toBe("Updated");
  });

  test("delete mutation invalidates cache", async () => {
    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });
    await store.create("task", { id: "t2", title: "Task 2", priority: 2 });

    // Warm up list cache
    const result1 = await gql(`query { taskList { total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result1.data.taskList as any).total).toBe(2);

    // Delete one
    await gql(`mutation { deleteTask(id: "t1") }`);

    // List should reflect deletion (cache was invalidated)
    const result2 = await gql(`query { taskList { total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result2.data.taskList as any).total).toBe(1);
  });

  test("works without cacheManager (no cache, direct query)", async () => {
    // Build schema without cache
    const noCacheSchema = buildGraphQLSchema([taskSchema], {
      executor,
      dataProvider: store,
      // no cacheManager
    });
    const noCacheApp = createServer(noCacheSchema);

    await store.create("task", { id: "t1", title: "Task 1", priority: 1 });
    const res = await noCacheApp.handle(
      new Request(GQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query { taskList { total } }` }),
      }),
    );
    const result = (await res.json()) as { data: Record<string, unknown> };
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((result.data.taskList as any).total).toBe(1);
  });

  test("different filter args produce different cache entries", async () => {
    await store.create("task", { id: "t1", title: "Alpha", priority: 1 });
    await store.create("task", { id: "t2", title: "Beta", priority: 2 });

    // Query with pageSize=1
    const r1 = await gql(`query { taskList(pageSize: 1) { items { id } total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((r1.data.taskList as any).items).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((r1.data.taskList as any).total).toBe(2);

    // Query with pageSize=2 — different cache key
    const r2 = await gql(`query { taskList(pageSize: 2) { items { id } total } }`);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((r2.data.taskList as any).items).toHaveLength(2);
    // biome-ignore lint/suspicious/noExplicitAny: GraphQL response type is unknown
    expect((r2.data.taskList as any).total).toBe(2);
  });
});
