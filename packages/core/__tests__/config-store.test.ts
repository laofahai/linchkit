/**
 * Tests for InMemoryConfigStore (spec 42 §9.1)
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  InMemoryConfigStore,
  resolveWithCascade,
} from "../src/config/config-store";

describe("InMemoryConfigStore", () => {
  let store: InMemoryConfigStore;

  beforeEach(() => {
    store = new InMemoryConfigStore();
  });

  describe("get/set", () => {
    it("returns undefined for unset key", async () => {
      const v = await store.get("cap-foo", "apiKey");
      expect(v).toBeUndefined();
    });

    it("stores and retrieves a global value", async () => {
      await store.set("cap-foo", "apiKey", "abc123");
      const v = await store.get("cap-foo", "apiKey", { type: "global" });
      expect(v).toBe("abc123");
    });

    it("default scope is global", async () => {
      await store.set("cap-foo", "apiKey", "abc123");
      const v = await store.get("cap-foo", "apiKey");
      expect(v).toBe("abc123");
    });

    it("stores tenant-scoped value separately from global", async () => {
      await store.set("cap-foo", "threshold", 100);
      await store.set("cap-foo", "threshold", 200, { scope: { type: "tenant", id: "t1" } });

      expect(await store.get("cap-foo", "threshold", { type: "global" })).toBe(100);
      expect(await store.get("cap-foo", "threshold", { type: "tenant", id: "t1" })).toBe(200);
    });

    it("stores json values", async () => {
      const obj = { a: 1, b: [1, 2, 3] };
      await store.set("ns", "key", obj);
      expect(await store.get("ns", "key")).toEqual(obj);
    });

    it("overwrites existing value", async () => {
      await store.set("ns", "key", "v1");
      await store.set("ns", "key", "v2");
      expect(await store.get("ns", "key")).toBe("v2");
    });
  });

  describe("history", () => {
    it("returns empty list for new key", async () => {
      const h = await store.history("ns", "key");
      expect(h).toEqual([]);
    });

    it("tracks version history in most-recent-first order", async () => {
      await store.set("ns", "key", "v1", { changedBy: "user1" });
      await store.set("ns", "key", "v2", { changedBy: "user2" });
      await store.set("ns", "key", "v3");

      const h = await store.history("ns", "key");
      expect(h).toHaveLength(3);
      expect(h[0].version).toBe(3);
      expect(h[0].value).toBe("v3");
      expect(h[1].version).toBe(2);
      expect(h[1].value).toBe("v2");
      expect(h[1].changedBy).toBe("user2");
      expect(h[2].version).toBe(1);
      expect(h[2].value).toBe("v1");
    });

    it("history is scoped separately", async () => {
      await store.set("ns", "key", "global-v1");
      await store.set("ns", "key", "tenant-v1", { scope: { type: "tenant", id: "t1" } });

      const globalH = await store.history("ns", "key", { type: "global" });
      const tenantH = await store.history("ns", "key", { type: "tenant", id: "t1" });

      expect(globalH).toHaveLength(1);
      expect(tenantH).toHaveLength(1);
      expect(globalH[0].value).toBe("global-v1");
      expect(tenantH[0].value).toBe("tenant-v1");
    });
  });

  describe("rollback", () => {
    it("rolls back to an earlier version", async () => {
      await store.set("ns", "key", "v1");
      await store.set("ns", "key", "v2");
      await store.set("ns", "key", "v3");

      await store.rollback("ns", "key", 1, { changeReason: "bad update" });

      expect(await store.get("ns", "key")).toBe("v1");

      const h = await store.history("ns", "key");
      expect(h[0].version).toBe(4); // new version record created
      expect(h[0].value).toBe("v1");
      expect(h[0].changeReason).toBe("bad update");
    });

    it("throws for non-existent version", async () => {
      await store.set("ns", "key", "v1");
      await expect(store.rollback("ns", "key", 99)).rejects.toThrow("version 99 not found");
    });
  });

  describe("delete", () => {
    it("removes a scoped entry", async () => {
      await store.set("ns", "key", "global");
      await store.set("ns", "key", "tenant", { scope: { type: "tenant", id: "t1" } });

      await store.delete("ns", "key", { type: "tenant", id: "t1" });

      expect(await store.get("ns", "key", { type: "global" })).toBe("global");
      expect(await store.get("ns", "key", { type: "tenant", id: "t1" })).toBeUndefined();
    });

    it("removes all scopes when no scope given", async () => {
      await store.set("ns", "key", "global");
      await store.set("ns", "key", "tenant", { scope: { type: "tenant", id: "t1" } });

      await store.delete("ns", "key");

      expect(await store.get("ns", "key")).toBeUndefined();
      expect(await store.get("ns", "key", { type: "tenant", id: "t1" })).toBeUndefined();
    });
  });

  describe("list", () => {
    it("lists all entries in namespace", async () => {
      await store.set("ns", "key1", "a");
      await store.set("ns", "key2", "b");
      await store.set("other", "key1", "c");

      const entries = await store.list("ns");
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.key).sort()).toEqual(["key1", "key2"]);
    });

    it("filters by scope", async () => {
      await store.set("ns", "key1", "global");
      await store.set("ns", "key1", "tenant", { scope: { type: "tenant", id: "t1" } });

      const global = await store.list("ns", { type: "global" });
      expect(global).toHaveLength(1);
      expect(global[0].scope).toBe("global");

      const tenant = await store.list("ns", { type: "tenant", id: "t1" });
      expect(tenant).toHaveLength(1);
      expect(tenant[0].scope).toBe("tenant");
    });
  });
});

describe("resolveWithCascade", () => {
  it("cascades from user → department → tenant → global", async () => {
    const store = new InMemoryConfigStore();
    await store.set("ns", "key", "global");
    await store.set("ns", "key", "tenant-val", { scope: { type: "tenant", id: "t1" } });

    // user with matching tenant → returns tenant-scoped
    const v = await resolveWithCascade(store, "ns", "key", { tenantId: "t1" });
    expect(v).toBe("tenant-val");

    // no actor → global
    const v2 = await resolveWithCascade(store, "ns", "key");
    expect(v2).toBe("global");
  });

  it("returns undefined when no value set at any scope", async () => {
    const store = new InMemoryConfigStore();
    const v = await resolveWithCascade(store, "ns", "missing");
    expect(v).toBeUndefined();
  });

  it("user scope wins over tenant", async () => {
    const store = new InMemoryConfigStore();
    await store.set("ns", "key", "tenant-val", { scope: { type: "tenant", id: "t1" } });
    await store.set("ns", "key", "user-val", { scope: { type: "user", id: "u1" } });

    const v = await resolveWithCascade(store, "ns", "key", { id: "u1", tenantId: "t1" });
    expect(v).toBe("user-val");
  });
});
