import { describe, expect, test } from "bun:test";
import { createCacheHealthCheck } from "../src/cache/cache-health";
import { CacheManager } from "../src/cache/cache-manager";
import { InMemoryCacheProvider } from "../src/cache/in-memory-cache";
import type { HealthCheckResult } from "../src/deployment/health-check";

// ── getStats() ───────────────────────────────────────────

describe("CacheManager.getStats()", () => {
  test("returns zeroed stats on fresh cache", () => {
    const cm = new CacheManager();
    const stats = cm.getStats();

    expect(stats.totalEntries).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.evictions).toBe(0);
    expect(stats.estimatedMemoryBytes).toBe(0);
    expect(stats.namespaces).toEqual({});
  });

  test("tracks hits and misses correctly", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.set("b", 2);

    cm.get("a"); // hit
    cm.get("b"); // hit
    cm.get("c"); // miss

    const stats = cm.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
  });

  test("tracks total entries", () => {
    const cm = new CacheManager();
    cm.set("x", 10);
    cm.set("y", 20);
    cm.set("z", 30);

    const stats = cm.getStats();
    expect(stats.totalEntries).toBe(3);
  });

  test("tracks evictions with small maxSize", () => {
    const l1 = new InMemoryCacheProvider({ maxSize: 2 });
    const cm = new CacheManager({ l1 });

    cm.set("a", 1);
    cm.set("b", 2);
    cm.set("c", 3); // evicts "a"

    const stats = cm.getStats();
    expect(stats.evictions).toBe(1);
    expect(stats.totalEntries).toBe(2);
  });

  test("calculates memory estimate with default avg size", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.set("b", 2);

    const stats = cm.getStats();
    // default avgEntrySizeBytes = 256
    expect(stats.estimatedMemoryBytes).toBe(2 * 256);
  });

  test("calculates memory estimate with custom avg size", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.set("b", 2);
    cm.set("c", 3);

    const stats = cm.getStats({ avgEntrySizeBytes: 512 });
    expect(stats.estimatedMemoryBytes).toBe(3 * 512);
  });

  test("provides per-namespace breakdown", () => {
    const cm = new CacheManager();
    const nsA = cm.namespace("alpha");
    const nsB = cm.namespace("beta");

    nsA.set("k1", 1);
    nsA.set("k2", 2);
    nsB.set("k1", 10);

    const stats = cm.getStats();
    expect(stats.namespaces.alpha).toBe(2);
    expect(stats.namespaces.beta).toBe(1);
  });

  test("groups keys without colon under _default namespace", () => {
    const cm = new CacheManager();
    cm.set("bare_key", 42);

    const stats = cm.getStats();
    expect(stats.namespaces._default).toBe(1);
  });

  test("exposes raw l1 and l2 stats", () => {
    const cm = new CacheManager();
    cm.set("x", 1);
    cm.get("x");

    const stats = cm.getStats();
    expect(stats.l1).toBeDefined();
    expect(stats.l1.hits).toBe(1);
    expect(stats.l2).toBeUndefined();
  });

  test("hit rate is 0 when no requests made", () => {
    const cm = new CacheManager();
    const stats = cm.getStats();
    expect(stats.hitRate).toBe(0);
  });

  test("hit rate is 1.0 when all requests hit", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.get("a");
    cm.get("a");
    cm.get("a");

    const stats = cm.getStats();
    expect(stats.hitRate).toBe(1);
  });
});

// ── InMemoryCacheProvider.keys() ─────────────────────────

describe("InMemoryCacheProvider.keys()", () => {
  test("returns empty array on fresh provider", () => {
    const provider = new InMemoryCacheProvider();
    expect(provider.keys()).toEqual([]);
  });

  test("returns all stored keys", () => {
    const provider = new InMemoryCacheProvider();
    provider.set("a", 1);
    provider.set("b", 2);
    provider.set("c", 3);

    const keys = provider.keys();
    expect(keys).toHaveLength(3);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
  });
});

// ── createCacheHealthCheck() ─────────────────────────────

describe("createCacheHealthCheck()", () => {
  test("returns healthy for operational cache", () => {
    const cm = new CacheManager();
    const check = createCacheHealthCheck(cm);
    const result = check() as HealthCheckResult;

    expect(result).toBeDefined();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("cache");
  });

  test("includes stats metadata when healthy", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.get("a");

    const check = createCacheHealthCheck(cm);
    const result = check() as HealthCheckResult;

    expect(result.metadata).toBeDefined();
    expect(result.metadata?.totalEntries).toBeDefined();
    expect(result.metadata?.hitRate).toBeDefined();
  });

  test("returns degraded when hit rate below threshold", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    // Generate misses
    cm.get("miss1");
    cm.get("miss2");
    cm.get("miss3");
    cm.get("miss4");
    // One hit
    cm.get("a");

    // Hit rate = 1/5 = 0.20, threshold = 0.50
    const check = createCacheHealthCheck(cm, { minHitRate: 0.5 });
    const result = check() as HealthCheckResult;

    expect(result.status).toBe("degraded");
    expect(result.message).toContain("below threshold");
  });

  test("returns healthy when hit rate above threshold", () => {
    const cm = new CacheManager();
    cm.set("a", 1);
    cm.set("b", 2);
    // All hits
    cm.get("a");
    cm.get("b");
    cm.get("a");

    const check = createCacheHealthCheck(cm, { minHitRate: 0.5 });
    const result = check() as HealthCheckResult;

    expect(result.status).toBe("healthy");
  });

  test("hit rate check skipped when no traffic yet", () => {
    const cm = new CacheManager();
    const check = createCacheHealthCheck(cm, { minHitRate: 0.9 });
    const result = check() as HealthCheckResult;

    // No requests yet, threshold should not trigger degraded
    expect(result.status).toBe("healthy");
  });

  test("hit rate threshold 0 (default) never triggers degraded", () => {
    const cm = new CacheManager();
    // All misses
    cm.get("x");
    cm.get("y");

    const check = createCacheHealthCheck(cm);
    const result = check() as HealthCheckResult;

    expect(result.status).toBe("healthy");
  });

  test("uses custom probe key", () => {
    const cm = new CacheManager();
    const check = createCacheHealthCheck(cm, { probeKey: "__custom_probe__" });
    const result = check() as HealthCheckResult;

    expect(result.status).toBe("healthy");
    // Probe keys use unique suffix and are cleaned up — no leftover keys with the prefix
    const stats = cm.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  test("reports durationMs >= 0", () => {
    const cm = new CacheManager();
    const check = createCacheHealthCheck(cm);
    const result = check() as HealthCheckResult;

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
