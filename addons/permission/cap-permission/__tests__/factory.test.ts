import { describe, expect, it } from "bun:test";
import { PermissionRegistry } from "@linchkit/core/server";
import { createCapPermission } from "../src/factory";

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
});
