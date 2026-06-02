import { describe, expect, it } from "bun:test";
import type { EventRecord } from "@linchkit/core";
import { CacheManager, PermissionRegistry } from "@linchkit/core/server";
import { createCapPermission } from "../src/factory";

/** Minimal write EventRecord for driving CacheManager.handleEvent in tests. */
function writeEvent(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: "evt-test",
    type: "record.deleted",
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: "exec-test",
    payload: {},
    ...overrides,
  };
}

describe("createCapPermission", () => {
  describe("without options", () => {
    const def = createCapPermission();

    it("returns a valid CapabilityDefinition with correct metadata", () => {
      expect(def.name).toBe("cap-permission");
      expect(def.type).toBe("standard");
      expect(def.category).toBe("system");
      expect(def.version).toBe("0.0.1");
      expect(def.label).toBe("Permission Management");
    });

    it("depends on cap-auth", () => {
      expect(def.dependencies).toContain("cap-auth");
    });

    it("includes 2 schemas (permission_group, permission_assignment)", () => {
      expect(def.entities).toHaveLength(2);
      const names = def.entities?.map((s) => s.name) ?? [];
      expect(names).toContain("permission_group");
      expect(names).toContain("permission_assignment");
    });

    it("includes 4 actions", () => {
      expect(def.actions).toHaveLength(4);
      const names = def.actions?.map((a) => a.name) ?? [];
      expect(names).toContain("create_group");
      expect(names).toContain("assign_user");
      expect(names).toContain("revoke_user");
      expect(names).toContain("update_permissions");
    });

    it("declares system permissions", () => {
      expect(def.systemPermissions).toContain("database.read");
      expect(def.systemPermissions).toContain("database.write");
      expect(def.systemPermissions).toContain("event.emit");
    });

    it("has no middlewares in extensions", () => {
      expect(def.extensions).toBeUndefined();
    });
  });

  describe("with registry and publicActions", () => {
    const registry = new PermissionRegistry();
    const def = createCapPermission({
      registry,
      publicActions: ["health_check"],
    });

    it("returns definition with correct metadata", () => {
      expect(def.name).toBe("cap-permission");
      expect(def.type).toBe("standard");
      expect(def.category).toBe("system");
      expect(def.version).toBe("0.0.1");
    });

    it("registers permission middleware in extensions", () => {
      expect(def.extensions).toBeDefined();
      expect(def.extensions?.middlewares).toBeDefined();
      expect(def.extensions?.middlewares).toHaveLength(1);
    });

    it("middleware has slot 'permission' and priority 50", () => {
      const mw = def.extensions?.middlewares?.[0];
      expect(mw?.slot).toBe("permission");
      expect(mw?.priority).toBe(50);
    });

    it("middleware handler is a function", () => {
      const mw = def.extensions?.middlewares?.[0];
      expect(typeof mw?.handler).toBe("function");
    });

    it("still includes schemas and actions", () => {
      expect(def.entities).toHaveLength(2);
      expect(def.actions).toHaveLength(4);
    });
  });

  describe("with registry only (no publicActions)", () => {
    const registry = new PermissionRegistry();
    const def = createCapPermission({ registry });

    it("registers middleware even without publicActions", () => {
      expect(def.extensions?.middlewares).toHaveLength(1);
      expect(def.extensions?.middlewares?.[0]?.slot).toBe("permission");
      expect(def.extensions?.middlewares?.[0]?.priority).toBe(50);
    });
  });

  // The permission domain owns the knowledge of which entity writes flush the
  // permission-decision cache; createCapPermission registers that rule on the
  // shared CacheManager (core stays domain-agnostic).
  describe("with cacheManager (perm-cache invalidation wiring)", () => {
    it("flushes perm:{tenant} when a permission_assignment write occurs (assign/revoke_user)", () => {
      const cacheManager = new CacheManager();
      createCapPermission({ cacheManager });

      cacheManager.set("decision", "allowed", { tags: ["perm:t1"] });
      // revoke_user deletes a permission_assignment row — the fail-open case.
      cacheManager.handleEvent(
        writeEvent({ type: "record.deleted", entity: "permission_assignment", tenantId: "t1" }),
      );
      expect(cacheManager.get("decision")).toBeUndefined();
    });

    it("flushes on permission_group writes but ignores unrelated entities", () => {
      const cacheManager = new CacheManager();
      createCapPermission({ cacheManager });

      cacheManager.set("d1", "allowed", { tags: ["perm:t1"] });
      cacheManager.handleEvent(
        writeEvent({ type: "record.updated", entity: "permission_group", tenantId: "t1" }),
      );
      expect(cacheManager.get("d1")).toBeUndefined();

      cacheManager.set("d2", "allowed", { tags: ["perm:t1"] });
      cacheManager.handleEvent(
        writeEvent({ type: "record.updated", entity: "orders", tenantId: "t1" }),
      );
      expect(cacheManager.get("d2")).toBe("allowed");
    });

    it("does not register a rule (no-op) when no cacheManager is provided", () => {
      // Smoke: constructing without a cacheManager must not throw.
      expect(() => createCapPermission()).not.toThrow();
    });
  });
});
