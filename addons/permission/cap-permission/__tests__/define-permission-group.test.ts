/**
 * Tests for definePermissionGroup — object-style entry (Phase 1 of #142).
 */

import { describe, expect, it } from "bun:test";
import {
  definePermissionGroup,
  type PermissionGroupDefinition,
} from "../src/define-permission-group";

describe("definePermissionGroup", () => {
  it("returns the definition unchanged for a minimal input", () => {
    const def = definePermissionGroup({ name: "base_user" });
    expect(def).toEqual({ name: "base_user" });
  });

  it("preserves all canonical Phase 1 fields verbatim", () => {
    const input: PermissionGroupDefinition = {
      name: "purchase_manager",
      label: "采购管理员",
      description: "Approves and rejects purchase requests",
      category: "purchase_management",
      implies: ["purchase_user"],
      grant: {
        purchase_request: {
          actions: { approve_request: true, reject_request: true },
          data: { read: "all" },
        },
      },
    };

    const def = definePermissionGroup(input);

    expect(def).toBe(input); // identity: no clone, no mutation
    expect(def.name).toBe("purchase_manager");
    expect(def.category).toBe("purchase_management");
    expect(def.implies).toEqual(["purchase_user"]);
    expect(def.grant?.purchase_request?.actions?.approve_request).toBe(true);
    expect(def.grant?.purchase_request?.data?.read).toBe("all");
  });

  it("throws if `name` is missing or invalid", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => definePermissionGroup({})).toThrow(/name/);
    // @ts-expect-error — testing runtime guard
    expect(() => definePermissionGroup({ name: 123 })).toThrow(/name/);
    expect(() => definePermissionGroup({ name: "" })).toThrow(/name/);
  });

  it("supports legacy `permissions` alongside new `grant`", () => {
    const def = definePermissionGroup({
      name: "legacy_user",
      permissions: {
        purchase_management: {
          purchase_request: { actions: { create_request: true } },
        },
      },
      grant: {
        purchase_request: { actions: { create_request: true } },
      },
    });

    expect(def.permissions).toBeDefined();
    expect(def.grant).toBeDefined();
  });

  it("supports systemLevel and constraints", () => {
    const def = definePermissionGroup({
      name: "system_admin",
      systemLevel: "admin",
      constraints: {
        auditLevel: "full",
      },
    });
    expect(def.systemLevel).toBe("admin");
    expect(def.constraints?.auditLevel).toBe("full");
  });

  it("produces a JSON-serializable plain object (JSONB-safe)", () => {
    const def = definePermissionGroup({
      name: "purchase_manager",
      category: "purchase_management",
      implies: ["purchase_user"],
      grant: {
        purchase_request: {
          actions: { approve_request: true },
          data: { read: "all" },
        },
      },
    });

    const json = JSON.stringify(def);
    const reparsed = JSON.parse(json);
    expect(reparsed).toEqual(def);
  });
});
