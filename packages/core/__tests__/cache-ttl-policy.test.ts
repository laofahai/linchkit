import { describe, expect, it } from "bun:test";
import { CacheManager } from "../src/cache/cache-manager";
import {
  type CacheTtlPolicy,
  DEFAULT_TTL_POLICIES,
  resolveTtlForNamespace,
} from "../src/cache/cache-ttl-policy";

// ── resolveTtlForNamespace ──────────────────────────────────

describe("resolveTtlForNamespace", () => {
  it("returns undefined when no policies are provided", () => {
    expect(resolveTtlForNamespace("query", [])).toBeUndefined();
  });

  it("returns undefined when namespace does not match any policy", () => {
    expect(resolveTtlForNamespace("unknown", DEFAULT_TTL_POLICIES)).toBeUndefined();
  });

  it("matches exact namespace", () => {
    const result = resolveTtlForNamespace("override", DEFAULT_TTL_POLICIES);
    expect(result).toBeDefined();
    expect(result?.ttl).toBe(5 * 60 * 1000);
    expect(result?.swrTtl).toBe(1 * 60 * 1000);
  });

  it("matches namespace prefix with colon separator", () => {
    const result = resolveTtlForNamespace("query:tenant1", DEFAULT_TTL_POLICIES);
    expect(result).toBeDefined();
    expect(result?.ttl).toBe(1 * 60 * 1000);
    expect(result?.swrTtl).toBeUndefined();
  });

  it("does not match partial namespace names without colon", () => {
    // "queryExtra" should NOT match "query" policy
    const result = resolveTtlForNamespace("queryExtra", DEFAULT_TTL_POLICIES);
    expect(result).toBeUndefined();
  });

  it("returns first matching policy when multiple could match", () => {
    const policies: CacheTtlPolicy[] = [
      { namespace: "query:tenant1", ttl: 5000 },
      { namespace: "query", ttl: 60000 },
    ];

    // More specific policy should win because it appears first
    const result = resolveTtlForNamespace("query:tenant1", policies);
    expect(result?.ttl).toBe(5000);
  });

  it("falls through to broader policy when specific does not match", () => {
    const policies: CacheTtlPolicy[] = [
      { namespace: "query:tenant1", ttl: 5000 },
      { namespace: "query", ttl: 60000 },
    ];

    const result = resolveTtlForNamespace("query:tenant2", policies);
    expect(result?.ttl).toBe(60000);
  });

  it("returns swrTtl only when defined in the policy", () => {
    const result = resolveTtlForNamespace("perm", DEFAULT_TTL_POLICIES);
    expect(result).toBeDefined();
    expect(result?.ttl).toBe(10 * 60 * 1000);
    expect(result?.swrTtl).toBeUndefined();
  });

  it("supports deeply nested namespace prefixes", () => {
    const result = resolveTtlForNamespace("override:t1:entity:order", DEFAULT_TTL_POLICIES);
    expect(result).toBeDefined();
    expect(result?.ttl).toBe(5 * 60 * 1000);
  });
});

// ── DEFAULT_TTL_POLICIES ────────────────────────────────────

describe("DEFAULT_TTL_POLICIES", () => {
  it("contains override policy with 5min TTL + 1min SWR", () => {
    const override = DEFAULT_TTL_POLICIES.find((p) => p.namespace === "override");
    expect(override).toBeDefined();
    expect(override?.ttl).toBe(300_000);
    expect(override?.swrTtl).toBe(60_000);
  });

  it("contains perm policy with 10min TTL", () => {
    const perm = DEFAULT_TTL_POLICIES.find((p) => p.namespace === "perm");
    expect(perm).toBeDefined();
    expect(perm?.ttl).toBe(600_000);
    expect(perm?.swrTtl).toBeUndefined();
  });

  it("contains query policy with 1min TTL", () => {
    const query = DEFAULT_TTL_POLICIES.find((p) => p.namespace === "query");
    expect(query).toBeDefined();
    expect(query?.ttl).toBe(60_000);
    expect(query?.swrTtl).toBeUndefined();
  });

  it("has exactly 3 default policies", () => {
    expect(DEFAULT_TTL_POLICIES).toHaveLength(3);
  });
});

// ── CacheManager TTL policy integration ─────────────────────

describe("CacheManager with ttlPolicies", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("auto-applies TTL from policy when namespace matches", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "query", ttl: 50 }],
    });

    const ns = manager.namespace("query");
    ns.set("key1", "value");

    expect(ns.get("key1")).toBe("value");
    await sleep(80);
    expect(ns.get("key1")).toBeUndefined();
  });

  it("does not apply TTL policy when explicit TTL is provided", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "query", ttl: 50 }],
    });

    const ns = manager.namespace("query");
    ns.set("key1", "value", { ttl: 300 });

    await sleep(80);
    // Explicit TTL of 300ms should keep value alive
    expect(ns.get("key1")).toBe("value");
  });

  it("auto-applies SWR from policy", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "override", ttl: 40, swrTtl: 200 }],
    });

    const ns = manager.namespace("override");
    ns.set("key1", "value");

    // Before soft expiry
    const before = ns.getWithStaleness("key1");
    expect(before?.value).toBe("value");
    expect(before?.isStale).toBe(false);

    // After soft expiry, within SWR window
    await sleep(60);
    const stale = ns.getWithStaleness("key1");
    expect(stale?.value).toBe("value");
    expect(stale?.isStale).toBe(true);
  });

  it("explicit swrTtl in set() overrides policy swrTtl", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "override", ttl: 40, swrTtl: 200 }],
    });

    const ns = manager.namespace("override");
    // Provide explicit swrTtl of 10ms (overriding policy's 200ms)
    ns.set("key1", "value", { swrTtl: 10 });

    await sleep(60);
    // Hard expiry at 40 + 10 = 50ms, so should be expired
    expect(ns.get("key1")).toBeUndefined();
  });

  it("does not apply policy to namespaces that do not match", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "query", ttl: 50 }],
    });

    const ns = manager.namespace("other");
    ns.set("key1", "value");

    await sleep(80);
    // No TTL policy matched, so value should still be alive
    expect(ns.get("key1")).toBe("value");
  });

  it("applies policy to tenant-prefixed namespaces", async () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "perm", ttl: 50 }],
    });

    const ns = manager.namespace("perm:tenant1");
    ns.set("actions", ["read", "write"]);

    expect(ns.get("actions")).toEqual(["read", "write"]);
    await sleep(80);
    expect(ns.get("actions")).toBeUndefined();
  });

  it("preserves tags when auto-applying TTL policy", () => {
    const manager = new CacheManager({
      ttlPolicies: [{ namespace: "query", ttl: 60000 }],
    });

    const ns = manager.namespace("query");
    ns.set("key1", "value", { tags: ["entity:orders"] });

    // Tag-based invalidation should still work
    const count = manager.invalidateByTag("entity:orders");
    expect(count).toBe(1);
    expect(ns.get("key1")).toBeUndefined();
  });
});
