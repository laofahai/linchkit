import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CacheManager } from "../src/cache/cache-manager";
import { createTenantNamespace } from "../src/cache/tenant-cache";

// ── createTenantNamespace ───────────────────────────────────

describe("createTenantNamespace", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(() => {
    manager.clear();
  });

  it("prefixes keys with namespace and tenant ID", () => {
    const ns = createTenantNamespace(manager, "query", "t1");
    ns.set("orders:abc", "result");

    // The key in the underlying manager should be "query:t1:orders:abc"
    expect(manager.get("query:t1:orders:abc")).toBe("result");
  });

  it("isolates data between tenants", () => {
    const nsT1 = createTenantNamespace(manager, "query", "t1");
    const nsT2 = createTenantNamespace(manager, "query", "t2");

    nsT1.set("key", "tenant1-value");
    nsT2.set("key", "tenant2-value");

    expect(nsT1.get("key")).toBe("tenant1-value");
    expect(nsT2.get("key")).toBe("tenant2-value");
  });

  it("isolates data between namespaces for the same tenant", () => {
    const queryNs = createTenantNamespace(manager, "query", "t1");
    const permNs = createTenantNamespace(manager, "perm", "t1");

    queryNs.set("key", "query-value");
    permNs.set("key", "perm-value");

    expect(queryNs.get("key")).toBe("query-value");
    expect(permNs.get("key")).toBe("perm-value");
  });

  it("invalidateAll only clears keys for the specific tenant namespace", () => {
    const nsT1 = createTenantNamespace(manager, "query", "t1");
    const nsT2 = createTenantNamespace(manager, "query", "t2");

    nsT1.set("a", 1);
    nsT1.set("b", 2);
    nsT2.set("a", 3);

    const count = nsT1.invalidateAll();
    expect(count).toBe(2);

    // t1 keys are gone
    expect(nsT1.get("a")).toBeUndefined();
    expect(nsT1.get("b")).toBeUndefined();

    // t2 key is still alive
    expect(nsT2.get("a")).toBe(3);
  });

  it("delete removes only the specified key for the tenant", () => {
    const ns = createTenantNamespace(manager, "perm", "t1");

    ns.set("actions", ["read"]);
    ns.set("filter", { status: "active" });

    expect(ns.delete("actions")).toBe(true);
    expect(ns.get("actions")).toBeUndefined();
    expect(ns.get("filter")).toEqual({ status: "active" });
  });

  it("delete returns false for non-existent key", () => {
    const ns = createTenantNamespace(manager, "perm", "t1");
    expect(ns.delete("nonexistent")).toBe(false);
  });

  it("supports tag-based invalidation across tenants", () => {
    const nsT1 = createTenantNamespace(manager, "query", "t1");
    const nsT2 = createTenantNamespace(manager, "query", "t2");

    nsT1.set("orders", "t1-orders", { tags: ["entity:orders"] });
    nsT2.set("orders", "t2-orders", { tags: ["entity:orders"] });

    // Invalidate by tag clears both tenants
    const count = nsT1.invalidateByTag("entity:orders");
    expect(count).toBe(2);
    expect(nsT1.get("orders")).toBeUndefined();
    expect(nsT2.get("orders")).toBeUndefined();
  });

  it("supports tenant-scoped tag invalidation", () => {
    const nsT1 = createTenantNamespace(manager, "query", "t1");
    const nsT2 = createTenantNamespace(manager, "query", "t2");

    nsT1.set("orders", "t1-orders", { tags: ["entity:t1:orders"] });
    nsT2.set("orders", "t2-orders", { tags: ["entity:t2:orders"] });

    // Invalidate only t1's orders
    const count = manager.invalidateByTag("entity:t1:orders");
    expect(count).toBe(1);
    expect(nsT1.get("orders")).toBeUndefined();
    expect(nsT2.get("orders")).toBe("t2-orders");
  });

  it("supports getWithStaleness for SWR pattern", () => {
    const ns = createTenantNamespace(manager, "override", "t1");
    ns.set("entity:order", "merged-def", { ttl: 5000 });

    const result = ns.getWithStaleness("entity:order");
    expect(result?.value).toBe("merged-def");
    expect(result?.isStale).toBe(false);
  });

  it("returns undefined for getWithStaleness on missing key", () => {
    const ns = createTenantNamespace(manager, "override", "t1");
    expect(ns.getWithStaleness("missing")).toBeUndefined();
  });
});

// ── CacheManager.tenantNamespace convenience ────────────────

describe("CacheManager.tenantNamespace", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(() => {
    manager.clear();
  });

  it("produces same key structure as createTenantNamespace", () => {
    const fromHelper = createTenantNamespace(manager, "query", "t1");
    const fromMethod = manager.tenantNamespace("query", "t1");

    fromHelper.set("key", "helper-value");
    // Method-created namespace should see the same key
    expect(fromMethod.get("key")).toBe("helper-value");
  });

  it("provides tenant isolation via convenience method", () => {
    const nsT1 = manager.tenantNamespace("perm", "t1");
    const nsT2 = manager.tenantNamespace("perm", "t2");

    nsT1.set("actions", ["admin"]);
    nsT2.set("actions", ["read"]);

    expect(nsT1.get("actions")).toEqual(["admin"]);
    expect(nsT2.get("actions")).toEqual(["read"]);
  });

  it("scoped invalidation via tenantNamespace", () => {
    const nsT1 = manager.tenantNamespace("query", "t1");
    const nsT2 = manager.tenantNamespace("query", "t2");

    nsT1.set("a", 1);
    nsT1.set("b", 2);
    nsT2.set("a", 3);

    nsT1.invalidateAll();

    expect(nsT1.get("a")).toBeUndefined();
    expect(nsT2.get("a")).toBe(3);
  });

  it("applies TTL policies to tenant namespaces", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    manager = new CacheManager({
      ttlPolicies: [{ namespace: "perm", ttl: 50 }],
    });

    const ns = manager.tenantNamespace("perm", "t1");
    ns.set("actions", ["read"]);

    expect(ns.get("actions")).toEqual(["read"]);
    await sleep(80);
    expect(ns.get("actions")).toBeUndefined();
  });
});
