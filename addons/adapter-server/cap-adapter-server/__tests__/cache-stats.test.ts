/**
 * Tests for /internal/cache/stats endpoint (spec §9)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { CacheManager, createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
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

const app = createServer(graphqlSchema, { cacheManager });
const port = 3950;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
  cacheManager.clear();
});

describe("/internal/cache/stats endpoint", () => {
  test("returns cache stats when cacheManager is configured", async () => {
    const res = await fetch(`http://localhost:${port}/internal/cache/stats`);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.l1).toBeDefined();
    expect(body.data.timestamp).toBeDefined();

    const l1 = body.data.l1 as Record<string, unknown>;
    expect(typeof l1.hits).toBe("number");
    expect(typeof l1.misses).toBe("number");
    expect(typeof l1.evictions).toBe("number");
    expect(typeof l1.size).toBe("number");
    expect(typeof l1.hitRate).toBe("number");
    expect(typeof l1.evictionRate).toBe("number");
  });

  test("reflects hits and misses after cache operations", async () => {
    // Trigger a miss then a hit
    await store.create("task", { id: "t1", title: "Task 1" });

    const gql = async (query: string) =>
      fetch(`http://localhost:${port}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }).then((r) => r.json());

    await gql(`query { task(id: "t1") { id title } }`); // miss
    await gql(`query { task(id: "t1") { id title } }`); // hit

    const res = await fetch(`http://localhost:${port}/internal/cache/stats`);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    const l1 = body.data.l1 as Record<string, unknown>;
    expect(l1.hits as number).toBeGreaterThanOrEqual(1);
    expect(l1.misses as number).toBeGreaterThanOrEqual(1);
    expect(l1.hitRate as number).toBeGreaterThan(0);
  });

  test("returns error when cacheManager is not configured", async () => {
    const appWithoutCache = createServer(graphqlSchema);
    const noPort = 3951;
    appWithoutCache.listen(noPort);

    try {
      const res = await fetch(`http://localhost:${noPort}/internal/cache/stats`);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("No cache manager");
    } finally {
      appWithoutCache.stop();
    }
  });
});
