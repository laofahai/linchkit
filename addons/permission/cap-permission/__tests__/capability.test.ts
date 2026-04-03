import { describe, expect, it } from "bun:test";
import { capPermission } from "../src/capability";

describe("cap-permission capability", () => {
  it("should have correct metadata", () => {
    expect(capPermission.name).toBe("cap-permission");
    expect(capPermission.type).toBe("standard");
    expect(capPermission.category).toBe("system");
    expect(capPermission.version).toBe("0.0.1");
  });

  it("should depend on cap-auth", () => {
    expect(capPermission.dependencies).toContain("cap-auth");
  });

  it("should define 2 schemas", () => {
    expect(capPermission.entities).toHaveLength(2);
    const names = capPermission.entities?.map((s) => s.name) ?? [];
    expect(names).toContain("permission_group");
    expect(names).toContain("permission_assignment");
  });

  it("should define 4 actions", () => {
    expect(capPermission.actions).toHaveLength(4);
    const names = capPermission.actions?.map((a) => a.name) ?? [];
    expect(names).toContain("create_group");
    expect(names).toContain("assign_user");
    expect(names).toContain("revoke_user");
    expect(names).toContain("update_permissions");
  });

  it("should declare system permissions with dot notation", () => {
    expect(capPermission.systemPermissions).toContain("database.read");
    expect(capPermission.systemPermissions).toContain("database.write");
  });
});
