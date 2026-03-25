import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CacheManager } from "../src/cache/cache-manager";
import { InMemoryCacheProvider } from "../src/cache/in-memory-cache";
import { createEventBus } from "../src/event/event-bus";
import type { EventRecord } from "../src/types/event";

// ── Test helpers ────────────────────────────────────────────

function makeEvent(type: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: crypto.randomUUID(),
    payload: {},
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── InMemoryCacheProvider ───────────────────────────────────

describe("InMemoryCacheProvider", () => {
  let cache: InMemoryCacheProvider;

  beforeEach(() => {
    cache = new InMemoryCacheProvider({ maxSize: 5 });
  });

  // -- Basic get/set/delete --

  it("returns undefined for missing keys", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a value", () => {
    cache.set("key1", { name: "Alice" });
    expect(cache.get<{ name: string }>("key1")).toEqual({ name: "Alice" });
  });

  it("overwrites existing key", () => {
    cache.set("key1", "v1");
    cache.set("key1", "v2");
    expect(cache.get("key1")).toBe("v2");
    expect(cache.stats().size).toBe(1);
  });

  it("deletes an existing key and returns true", () => {
    cache.set("key1", "v1");
    expect(cache.delete("key1")).toBe(true);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("returns false when deleting a non-existent key", () => {
    expect(cache.delete("nope")).toBe(false);
  });

  // -- TTL --

  it("expires entries after TTL", async () => {
    cache.set("ttl-key", "value", { ttl: 50 });
    expect(cache.get("ttl-key")).toBe("value");

    await sleep(80);
    expect(cache.get("ttl-key")).toBeUndefined();
  });

  it("does not expire entries without TTL", async () => {
    cache.set("no-ttl", "value");
    await sleep(50);
    expect(cache.get("no-ttl")).toBe("value");
  });

  // -- LRU eviction --

  it("evicts least-recently-used entries when maxSize is exceeded", () => {
    // Fill to capacity (maxSize = 5)
    for (let i = 0; i < 5; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.stats().size).toBe(5);

    // Access k0 to make it recently used
    cache.get("k0");

    // Add one more — should evict k1 (LRU, since k0 was just accessed)
    cache.set("k5", 5);
    expect(cache.stats().size).toBe(5);
    expect(cache.get("k1")).toBeUndefined(); // evicted
    expect(cache.get("k0")).toBe(0); // still present
    expect(cache.get("k5")).toBe(5); // newly added
  });

  it("tracks eviction count in stats", () => {
    for (let i = 0; i < 7; i++) {
      cache.set(`k${i}`, i);
    }
    expect(cache.stats().evictions).toBe(2);
  });

  // -- Tag-based invalidation --

  it("invalidates all entries with a given tag", () => {
    cache.set("a", 1, { tags: ["group1"] });
    cache.set("b", 2, { tags: ["group1", "group2"] });
    cache.set("c", 3, { tags: ["group2"] });

    const count = cache.invalidateByTag("group1");
    expect(count).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3); // unaffected
  });

  it("returns 0 when invalidating a tag with no entries", () => {
    expect(cache.invalidateByTag("nonexistent")).toBe(0);
  });

  // -- Prefix-based invalidation --

  it("invalidates all entries matching a prefix", () => {
    cache.set("query:tenant1:orders:abc", "r1");
    cache.set("query:tenant1:orders:def", "r2");
    cache.set("query:tenant1:products:ghi", "r3");
    cache.set("perm:tenant1:user1", "p1");

    const count = cache.invalidateByPrefix("query:tenant1:orders:");
    expect(count).toBe(2);
    expect(cache.get("query:tenant1:orders:abc")).toBeUndefined();
    expect(cache.get("query:tenant1:products:ghi")).toBe("r3");
    expect(cache.get("perm:tenant1:user1")).toBe("p1");
  });

  // -- clear --

  it("removes all entries on clear", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  // -- Stats --

  it("tracks hits and misses", () => {
    cache.set("a", 1);
    cache.get("a"); // hit
    cache.get("a"); // hit
    cache.get("b"); // miss

    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it("reports hitRate 0 when no operations performed", () => {
    expect(cache.stats().hitRate).toBe(0);
  });
});

// ── CacheManager ────────────────────────────────────────────

describe("CacheManager", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(() => {
    manager.clear();
  });

  // -- Basic operations --

  it("get/set/delete through the manager", () => {
    manager.set("key", "value");
    expect(manager.get("key")).toBe("value");

    manager.delete("key");
    expect(manager.get("key")).toBeUndefined();
  });

  it("applies default TTL when no TTL specified on set", async () => {
    manager = new CacheManager({ defaultTtl: 50 });
    manager.set("key", "value");

    expect(manager.get("key")).toBe("value");
    await sleep(80);
    expect(manager.get("key")).toBeUndefined();
  });

  it("explicit TTL overrides default TTL", async () => {
    manager = new CacheManager({ defaultTtl: 50 });
    manager.set("key", "value", { ttl: 200 });

    await sleep(80);
    // Should still be alive because explicit TTL is 200ms
    expect(manager.get("key")).toBe("value");
  });

  // -- Multi-layer (L1 + L2) --

  it("promotes L2 hit to L1", () => {
    const l1 = new InMemoryCacheProvider();
    const l2 = new InMemoryCacheProvider();
    manager = new CacheManager({ l1, l2 });

    // Write only to L2 directly
    l2.set("key", "from-l2", { tags: [] });

    // Manager should find it in L2 and promote to L1
    expect(manager.get("key")).toBe("from-l2");
    expect(l1.get("key")).toBe("from-l2");
  });

  it("writes to both L1 and L2", () => {
    const l1 = new InMemoryCacheProvider();
    const l2 = new InMemoryCacheProvider();
    manager = new CacheManager({ l1, l2 });

    manager.set("key", "value");
    expect(l1.get("key")).toBe("value");
    expect(l2.get("key")).toBe("value");
  });

  it("invalidateByTag clears from both layers", () => {
    const l1 = new InMemoryCacheProvider();
    const l2 = new InMemoryCacheProvider();
    manager = new CacheManager({ l1, l2 });

    manager.set("a", 1, { tags: ["t1"] });
    manager.set("b", 2, { tags: ["t2"] });

    const count = manager.invalidateByTag("t1");
    expect(count).toBe(2); // 1 from L1 + 1 from L2
    expect(l1.get("a")).toBeUndefined();
    expect(l2.get("a")).toBeUndefined();
    expect(l1.get("b")).toBe(2);
  });

  // -- Namespace --

  it("namespaces keys to avoid collision", () => {
    const nsA = manager.namespace("schemaA");
    const nsB = manager.namespace("schemaB");

    nsA.set("key", "fromA");
    nsB.set("key", "fromB");

    expect(nsA.get("key")).toBe("fromA");
    expect(nsB.get("key")).toBe("fromB");
  });

  it("namespace invalidateAll removes only namespaced keys", () => {
    const ns = manager.namespace("query");
    ns.set("a", 1);
    ns.set("b", 2);
    manager.set("other", 3);

    const count = ns.invalidateAll();
    expect(count).toBe(2);
    expect(ns.get("a")).toBeUndefined();
    expect(manager.get("other")).toBe(3);
  });

  it("namespace delete works correctly", () => {
    const ns = manager.namespace("ns");
    ns.set("k", "v");
    expect(ns.delete("k")).toBe(true);
    expect(ns.get("k")).toBeUndefined();
    expect(ns.delete("k")).toBe(false);
  });

  // -- Stats --

  it("returns stats for L1 and L2", () => {
    const l1 = new InMemoryCacheProvider();
    const l2 = new InMemoryCacheProvider();
    manager = new CacheManager({ l1, l2 });

    manager.set("key", "value");
    manager.get("key");

    const s = manager.stats();
    expect(s.l1).toBeDefined();
    expect(s.l2).toBeDefined();
    expect(s.l1.hits).toBe(1);
  });

  it("l2 stats are undefined when no L2 configured", () => {
    manager = new CacheManager();
    const s = manager.stats();
    expect(s.l2).toBeUndefined();
  });
});

// ── Event-driven invalidation ───────────────────────────────

describe("CacheManager event-driven invalidation", () => {
  it("invalidates schema query caches on record.created event", async () => {
    const { bus } = createEventBus();
    const manager = new CacheManager({ eventBus: bus });

    manager.set("data", "cached", { tags: ["schema:orders"] });
    expect(manager.get("data")).toBe("cached");

    await bus.emit(makeEvent("record.created", { schema: "orders" }));

    expect(manager.get("data")).toBeUndefined();
  });

  it("invalidates schema query caches with tenant scoping", async () => {
    const { bus } = createEventBus();
    const manager = new CacheManager({ eventBus: bus });

    manager.set("t1-data", "v1", { tags: ["schema:t1:orders"] });
    manager.set("t2-data", "v2", { tags: ["schema:t2:orders"] });

    await bus.emit(makeEvent("record.updated", { schema: "orders", tenantId: "t1" }));

    expect(manager.get("t1-data")).toBeUndefined();
    expect(manager.get("t2-data")).toBe("v2"); // different tenant, unaffected
  });

  it("invalidates permission caches on permission-related actions", async () => {
    const { bus } = createEventBus();
    const manager = new CacheManager({ eventBus: bus });

    manager.set("perm1", "allowed", { tags: ["perm:t1"] });
    manager.set("other", "value", { tags: ["schema:t1:products"] });

    await bus.emit(
      makeEvent("record.updated", {
        schema: "roles",
        tenantId: "t1",
        action: "assign_role_to_user",
      }),
    );

    expect(manager.get("perm1")).toBeUndefined();
    expect(manager.get("other")).toBe("value"); // different schema tag, unaffected
  });

  it("ignores non-write events", async () => {
    const { bus } = createEventBus();
    const manager = new CacheManager({ eventBus: bus });

    manager.set("data", "cached", { tags: ["schema:orders"] });

    await bus.emit(makeEvent("record.viewed", { schema: "orders" }));

    expect(manager.get("data")).toBe("cached");
  });

  it("handleEvent can be called directly without EventBus", () => {
    const manager = new CacheManager();
    manager.set("data", "cached", { tags: ["schema:orders"] });

    manager.handleEvent(makeEvent("record.deleted", { schema: "orders" }));

    expect(manager.get("data")).toBeUndefined();
  });
});

// ── Integration: Zod schema caching pattern ─────────────────

describe("Cache integration patterns", () => {
  it("caches expensive computation results and invalidates on write", () => {
    const manager = new CacheManager();
    const zodCache = manager.namespace("zod");

    let computeCount = 0;
    function getZodSchema(schemaName: string): object {
      const cached = zodCache.get<object>(schemaName);
      if (cached) return cached;

      computeCount++;
      const result = { type: "object", schema: schemaName };
      zodCache.set(schemaName, result, { tags: [`schema:${schemaName}`] });
      return result;
    }

    // First call computes
    const r1 = getZodSchema("purchase_request");
    expect(computeCount).toBe(1);

    // Second call hits cache
    const r2 = getZodSchema("purchase_request");
    expect(computeCount).toBe(1);
    expect(r2).toEqual(r1);

    // Invalidate by tag
    manager.invalidateByTag("schema:purchase_request");

    // Third call recomputes
    getZodSchema("purchase_request");
    expect(computeCount).toBe(2);
  });

  it("caches ontology descriptors with TTL and tags", async () => {
    const manager = new CacheManager();
    const ontologyCache = manager.namespace("ontology");

    ontologyCache.set(
      "describe:orders",
      { name: "orders", fields: {} },
      {
        ttl: 100,
        tags: ["schema:orders"],
      },
    );

    expect(ontologyCache.get("describe:orders")).toBeDefined();

    await sleep(150);
    expect(ontologyCache.get("describe:orders")).toBeUndefined();
  });

  it("supports query result caching pattern from spec §5", () => {
    const manager = new CacheManager();
    const queryCache = manager.namespace("query");

    // Simulate caching a query result
    const queryHash = "abc123";
    const cacheKey = `tenant1:orders:${queryHash}`;
    queryCache.set(cacheKey, [{ id: 1 }], {
      ttl: 30_000,
      tags: ["schema:tenant1:orders"],
    });

    expect(queryCache.get(cacheKey)).toEqual([{ id: 1 }]);

    // Simulate a write event invalidating all order queries for tenant1
    manager.handleEvent(makeEvent("record.created", { schema: "orders", tenantId: "tenant1" }));

    expect(queryCache.get(cacheKey)).toBeUndefined();
  });
});
