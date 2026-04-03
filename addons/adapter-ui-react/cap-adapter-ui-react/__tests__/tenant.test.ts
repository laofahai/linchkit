import { beforeEach, describe, expect, test } from "bun:test";
import { getActiveTenantId, getTenantHeaders, setActiveTenantId } from "../src/lib/tenant";

// Minimal localStorage shim for bun test (no DOM environment)
const store = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    configurable: true,
  });
}

describe("tenant utilities", () => {
  beforeEach(() => {
    store.clear();
  });

  describe("getActiveTenantId", () => {
    test("returns null when no tenant is set", () => {
      expect(getActiveTenantId()).toBeNull();
    });

    test("returns stored tenant ID", () => {
      localStorage.setItem("linchkit:tenant-id", "tenant-42");
      expect(getActiveTenantId()).toBe("tenant-42");
    });
  });

  describe("setActiveTenantId", () => {
    test("stores tenant ID", () => {
      setActiveTenantId("t-abc");
      expect(localStorage.getItem("linchkit:tenant-id")).toBe("t-abc");
    });

    test("clears tenant ID when null is passed", () => {
      setActiveTenantId("t-abc");
      setActiveTenantId(null);
      expect(localStorage.getItem("linchkit:tenant-id")).toBeNull();
    });

    test("overwrites previous tenant ID", () => {
      setActiveTenantId("t-1");
      setActiveTenantId("t-2");
      expect(getActiveTenantId()).toBe("t-2");
    });
  });

  describe("getTenantHeaders", () => {
    test("returns empty object when no tenant is set", () => {
      expect(getTenantHeaders()).toEqual({});
    });

    test("returns X-Tenant-Id header when tenant is set", () => {
      setActiveTenantId("tenant-99");
      expect(getTenantHeaders()).toEqual({ "X-Tenant-Id": "tenant-99" });
    });

    test("returns empty object after tenant is cleared", () => {
      setActiveTenantId("tenant-99");
      setActiveTenantId(null);
      expect(getTenantHeaders()).toEqual({});
    });
  });
});
