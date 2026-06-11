import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_HEADER,
  DEV_ROLES,
  getDevRole,
  getDevRoleHeaders,
  getStoredDevRole,
  setDevRole,
} from "../src/lib/dev-role";

// Minimal localStorage shim for bun test (no DOM environment) — same pattern
// as tenant.test.ts.
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

describe("dev-role utilities", () => {
  beforeEach(() => {
    // Clear via the live shim (another test file may have installed its own).
    localStorage.clear();
  });

  describe("contract constants", () => {
    test("header name matches the dev server resolver", () => {
      expect(DEV_ROLE_HEADER).toBe("x-dev-role");
    });

    test("roles match the dev server's recognized set, default is admin", () => {
      expect(DEV_ROLES).toEqual(["user", "manager", "admin"]);
      expect(DEFAULT_DEV_ROLE).toBe("admin");
    });
  });

  describe("getStoredDevRole", () => {
    test("returns null when nothing is stored", () => {
      expect(getStoredDevRole()).toBeNull();
    });

    test("returns the stored role", () => {
      localStorage.setItem("linchkit:dev-role", "manager");
      expect(getStoredDevRole()).toBe("manager");
    });

    test("treats an unrecognized stored value as no choice", () => {
      localStorage.setItem("linchkit:dev-role", "superadmin");
      expect(getStoredDevRole()).toBeNull();
    });
  });

  describe("getDevRole", () => {
    test("defaults to admin (= today's elevated no-auth behavior)", () => {
      expect(getDevRole()).toBe("admin");
    });

    test("returns the stored choice", () => {
      setDevRole("user");
      expect(getDevRole()).toBe("user");
    });
  });

  describe("setDevRole", () => {
    test("stores the role under linchkit:dev-role", () => {
      setDevRole("manager");
      expect(localStorage.getItem("linchkit:dev-role")).toBe("manager");
    });

    test("clears the choice when null is passed", () => {
      setDevRole("manager");
      setDevRole(null);
      expect(localStorage.getItem("linchkit:dev-role")).toBeNull();
      expect(getDevRole()).toBe("admin");
    });
  });

  describe("getDevRoleHeaders", () => {
    test("returns empty object when no explicit choice exists (no header sent)", () => {
      expect(getDevRoleHeaders()).toEqual({});
    });

    test("returns the x-dev-role header for an explicit choice", () => {
      setDevRole("user");
      expect(getDevRoleHeaders()).toEqual({ "x-dev-role": "user" });
    });

    test("sends the header even for an explicit admin choice", () => {
      setDevRole("admin");
      expect(getDevRoleHeaders()).toEqual({ "x-dev-role": "admin" });
    });

    test("returns empty object after the choice is cleared", () => {
      setDevRole("manager");
      setDevRole(null);
      expect(getDevRoleHeaders()).toEqual({});
    });

    test("ignores a corrupted stored value (back-compat: no header sent)", () => {
      localStorage.setItem("linchkit:dev-role", "root");
      expect(getDevRoleHeaders()).toEqual({});
    });
  });
});
