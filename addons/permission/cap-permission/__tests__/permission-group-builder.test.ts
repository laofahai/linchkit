/**
 * Tests for permissionGroup() chain builder — Phase 1 of #142.
 *
 * Critical invariants:
 *   1. Chain output deep-equals object-style output for equivalent input.
 *   2. `.build()` is idempotent (no mutation, no shared references).
 *   3. `.implies(...names)` accumulates and de-duplicates.
 *   4. `.on(a).allow(x).on(b).allow(y)` produces grants for both entities.
 *   5. Grant mutation methods require a prior `.on(...)` call.
 */

import { describe, expect, it } from "bun:test";
import { definePermissionGroup } from "../src/define-permission-group";
import { permissionGroup } from "../src/permission-group-builder";

describe("permissionGroup() chain builder", () => {
  it("produces the same object as definePermissionGroup() for equivalent input", () => {
    const objectStyle = definePermissionGroup({
      name: "purchase_manager",
      label: "采购管理员",
      category: "purchase_management",
      implies: ["purchase_user"],
      grant: {
        purchase_request: {
          actions: { approve_request: true, reject_request: true },
          data: { read: "all" },
        },
      },
    });

    const chainStyle = permissionGroup("purchase_manager")
      .label("采购管理员")
      .category("purchase_management")
      .implies("purchase_user")
      .on("purchase_request")
      .allow("approve_request", "reject_request")
      .readAll()
      .build();

    expect(chainStyle).toEqual(objectStyle);
  });

  it("matches the exact shape from the issue body example", () => {
    const objectStyle = definePermissionGroup({
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

    const chainStyle = permissionGroup("purchase_manager")
      .category("purchase_management")
      .implies("purchase_user")
      .on("purchase_request")
      .allow("approve_request")
      .readAll()
      .build();

    expect(chainStyle).toEqual(objectStyle);
  });

  describe(".implies()", () => {
    it("accumulates across multiple calls", () => {
      const def = permissionGroup("g").implies("a").implies("b", "c").implies("d").build();
      expect(def.implies).toEqual(["a", "b", "c", "d"]);
    });

    it("de-duplicates repeated names", () => {
      const def = permissionGroup("g").implies("a", "b").implies("a", "c").build();
      expect(def.implies).toEqual(["a", "b", "c"]);
    });

    it("omits the field entirely when never called", () => {
      const def = permissionGroup("g").build();
      expect(def.implies).toBeUndefined();
    });
  });

  describe(".on() context switching", () => {
    it(".on(a).allow(x).on(b).allow(y) produces both entity grants", () => {
      const def = permissionGroup("multi")
        .on("entity_a")
        .allow("action_x")
        .on("entity_b")
        .allow("action_y")
        .build();

      expect(def.grant).toEqual({
        entity_a: { actions: { action_x: true } },
        entity_b: { actions: { action_y: true } },
      });
    });

    it("returning to a previous entity merges grants", () => {
      const def = permissionGroup("multi")
        .on("entity_a")
        .allow("action_x")
        .on("entity_b")
        .allow("action_y")
        .on("entity_a")
        .readAll()
        .build();

      expect(def.grant?.entity_a).toEqual({
        actions: { action_x: true },
        data: { read: "all" },
      });
      expect(def.grant?.entity_b).toEqual({ actions: { action_y: true } });
    });

    it("creates an empty grant entry even with no subsequent mutations", () => {
      const def = permissionGroup("g").on("just_seen").build();
      expect(def.grant).toEqual({ just_seen: {} });
    });
  });

  describe(".allow() / .deny()", () => {
    it("supports multiple actions in one call", () => {
      const def = permissionGroup("g").on("e").allow("a", "b", "c").deny("d", "e").build();

      expect(def.grant?.e?.actions).toEqual({
        a: true,
        b: true,
        c: true,
        d: false,
        e: false,
      });
    });

    it("later .deny() overrides earlier .allow() for the same action", () => {
      const def = permissionGroup("g").on("e").allow("a").deny("a").build();
      expect(def.grant?.e?.actions?.a).toBe(false);
    });

    it("throws when called before .on()", () => {
      expect(() => permissionGroup("g").allow("a")).toThrow(/on\(entity\)/);
      expect(() => permissionGroup("g").deny("a")).toThrow(/on\(entity\)/);
    });
  });

  describe("data-access helpers", () => {
    it(".readAll() sets data.read = 'all'", () => {
      const def = permissionGroup("g").on("e").readAll().build();
      expect(def.grant?.e?.data).toEqual({ read: "all" });
    });

    it(".writeAll() sets data.write = 'all'", () => {
      const def = permissionGroup("g").on("e").writeAll().build();
      expect(def.grant?.e?.data).toEqual({ write: "all" });
    });

    it(".readAll() + .writeAll() combine into one data object", () => {
      const def = permissionGroup("g").on("e").readAll().writeAll().build();
      expect(def.grant?.e?.data).toEqual({ read: "all", write: "all" });
    });

    it(".ownRecords() sets read+write conditions on `created_by` by default", () => {
      const def = permissionGroup("g").on("e").ownRecords().build();
      expect(def.grant?.e?.data?.read).toEqual({
        condition: { field: "created_by", operator: "eq", value: "$actor.id" },
      });
      expect(def.grant?.e?.data?.write).toEqual({
        condition: { field: "created_by", operator: "eq", value: "$actor.id" },
      });
    });

    it(".ownRecords(field) honors a custom field name", () => {
      const def = permissionGroup("g").on("e").ownRecords("owner_id").build();
      expect(def.grant?.e?.data?.read).toEqual({
        condition: { field: "owner_id", operator: "eq", value: "$actor.id" },
      });
    });

    it("data helpers throw when called before .on()", () => {
      expect(() => permissionGroup("g").readAll()).toThrow(/on\(entity\)/);
      expect(() => permissionGroup("g").writeAll()).toThrow(/on\(entity\)/);
      expect(() => permissionGroup("g").ownRecords()).toThrow(/on\(entity\)/);
    });
  });

  describe("field-access helpers", () => {
    it(".visibleFields() and .hiddenFields() accumulate without dupes", () => {
      const def = permissionGroup("g")
        .on("e")
        .visibleFields("a", "b")
        .visibleFields("b", "c")
        .hiddenFields("x")
        .build();

      expect(def.grant?.e?.fields).toEqual({
        visible: ["a", "b", "c"],
        hidden: ["x"],
      });
    });
  });

  describe(".build() idempotency", () => {
    it("returns deep-equal but distinct objects on repeated calls", () => {
      const builder = permissionGroup("g")
        .category("c")
        .implies("base")
        .on("e")
        .allow("a")
        .readAll();

      const a = builder.build();
      const b = builder.build();

      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.grant).not.toBe(b.grant);
      expect(a.grant?.e).not.toBe(b.grant?.e);
      expect(a.implies).not.toBe(b.implies);
    });

    it("mutating one build() result does not affect the other", () => {
      const builder = permissionGroup("g").on("e").allow("a");

      const a = builder.build();
      const b = builder.build();

      // Mutate a's grant
      if (a.grant?.e?.actions) {
        a.grant.e.actions.b = true;
      }
      a.implies = ["leaked"];

      expect(b.grant?.e?.actions).toEqual({ a: true });
      expect(b.implies).toBeUndefined();
    });

    it("subsequent builder calls after build() reflect in next build()", () => {
      const builder = permissionGroup("g").on("e").allow("a");
      const first = builder.build();
      builder.allow("b");
      const second = builder.build();

      expect(first.grant?.e?.actions).toEqual({ a: true });
      expect(second.grant?.e?.actions).toEqual({ a: true, b: true });
    });
  });

  describe("misc", () => {
    it("throws for an empty group name", () => {
      expect(() => permissionGroup("")).toThrow(/name/);
    });

    it("supports .systemAdmin() shorthand", () => {
      const def = permissionGroup("admin").systemAdmin().build();
      expect(def.systemLevel).toBe("admin");
    });

    it("supports .constraints() and deep-clones them", () => {
      const constraints = {
        rateLimit: { maxActionsPerMinute: 60 },
        auditLevel: "full" as const,
      };
      const builder = permissionGroup("ai_agent").constraints(constraints);
      const built = builder.build();
      expect(built.constraints).toEqual(constraints);
      expect(built.constraints).not.toBe(constraints);
      expect(built.constraints?.rateLimit).not.toBe(constraints.rateLimit);
    });

    it("omits empty grant/implies from the materialized output", () => {
      const def = permissionGroup("g").label("L").build();
      expect(def).toEqual({ name: "g", label: "L" });
      expect("grant" in def).toBe(false);
      expect("implies" in def).toBe(false);
    });
  });
});
