/**
 * Regression tests for issue #202.
 *
 * Verify that EntityRegistry.resolve() preserves inherited FieldConstraints
 * (including Spec 63 `immutable`, `readonly`, `lockWhen`) when a child entity
 * redeclares a field by name. Constraints are inherited from parents unless
 * the child explicitly restates them — including explicit negation
 * (`immutable: false`, `lockWhen: undefined`). Visual properties (label,
 * description, ui hints) follow the existing child-wins semantics.
 *
 * Covers `extends`, `implements`, `applyExtension`, and `applyOverride`.
 */

import { describe, expect, it } from "bun:test";
import { createInterfaceRegistry } from "../src/entity/entity-interface";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { LockCondition } from "../src/types/entity";

const submittedLock: LockCondition = { state: "submitted" };
const approvedLock: LockCondition = { state: "approved" };

describe("EntityRegistry.resolve() — inherited constraint merge (issue #202)", () => {
  describe("extends", () => {
    it("child overriding only `label` keeps parent's `immutable: true`", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc_base",
        abstract: true,
        fields: {
          ref_no: {
            type: "string",
            label: "Reference",
            immutable: true,
            required: true,
          },
        },
      });
      registry.register({
        name: "doc_child",
        extends: "doc_base",
        fields: {
          // Only the visible label changes; child does NOT restate immutable.
          ref_no: { type: "string", label: "Document Reference" },
        },
      });

      const resolved = registry.resolve("doc_child");
      const def = resolved.fields.ref_no?.definition;

      expect(def?.immutable).toBe(true);
      expect(def?.required).toBe(true);
      expect(def?.label).toBe("Document Reference");
    });

    it("child overriding only `type` keeps parent's `immutable: true`", () => {
      // Note: type changes are blocked by the registry, so we use the same
      // type to exercise the "child redeclares with type only" path.
      const registry = createEntityRegistry();
      registry.register({
        name: "purchase_base",
        abstract: true,
        fields: {
          po_number: {
            type: "string",
            immutable: true,
            unique: true,
            required: true,
          },
        },
      });
      registry.register({
        name: "purchase_request",
        extends: "purchase_base",
        fields: {
          // Child only restates the type — every constraint must survive.
          po_number: { type: "string" },
        },
      });

      const resolved = registry.resolve("purchase_request");
      const def = resolved.fields.po_number?.definition;

      expect(def?.immutable).toBe(true);
      expect(def?.unique).toBe(true);
      expect(def?.required).toBe(true);
    });

    it("child explicitly setting `immutable: false` is respected (negation wins)", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "ticket_base",
        abstract: true,
        fields: {
          assignee: { type: "string", immutable: true },
        },
      });
      registry.register({
        name: "ticket_flexible",
        extends: "ticket_base",
        fields: {
          // Explicit negation — child wants this field mutable.
          assignee: { type: "string", immutable: false },
        },
      });

      const resolved = registry.resolve("ticket_flexible");
      expect(resolved.fields.assignee?.definition.immutable).toBe(false);
    });

    it("child explicitly setting `lockWhen: undefined` clears the inherited lock", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "form_base",
        abstract: true,
        fields: {
          notes: { type: "text", lockWhen: submittedLock },
        },
      });
      registry.register({
        name: "form_open",
        extends: "form_base",
        fields: {
          // Explicit undefined — child wants no lock.
          notes: { type: "text", lockWhen: undefined },
        },
      });

      const resolved = registry.resolve("form_open");
      const def = resolved.fields.notes?.definition;
      // lockWhen is explicitly cleared. Use `in` to confirm the key is
      // present so our negation semantics behave correctly.
      expect(def?.lockWhen).toBeUndefined();
      expect(Object.hasOwn(def as object, "lockWhen")).toBe(true);
    });

    it("child not restating `lockWhen` inherits parent's lockWhen", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "po_base",
        abstract: true,
        fields: {
          amount: { type: "number", lockWhen: submittedLock, min: 0 },
        },
      });
      registry.register({
        name: "po_v2",
        extends: "po_base",
        fields: {
          // No lockWhen, no min restated — both must inherit.
          amount: { type: "number", label: "Amount (USD)" },
        },
      });

      const resolved = registry.resolve("po_v2");
      const def = resolved.fields.amount?.definition;

      expect(def?.lockWhen).toEqual(submittedLock);
      expect(def?.min).toBe(0);
      expect(def?.label).toBe("Amount (USD)");
    });

    it("three-level inheritance composes constraints with most-derived explicit value winning", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "level1",
        abstract: true,
        fields: {
          code: {
            type: "string",
            immutable: true,
            unique: true,
            required: true,
            min: 3,
          },
        },
      });
      registry.register({
        name: "level2",
        extends: "level1",
        fields: {
          // Tightens min, leaves immutable/unique/required untouched.
          code: { type: "string", min: 5 },
        },
      });
      registry.register({
        name: "level3",
        extends: "level2",
        fields: {
          // Loosens immutable; everything else survives from ancestors.
          code: { type: "string", immutable: false },
        },
      });

      const resolved = registry.resolve("level3");
      const def = resolved.fields.code?.definition;

      // Level 3 explicitly negated immutable.
      expect(def?.immutable).toBe(false);
      // Inherited from level 1 (level 2 didn't touch them).
      expect(def?.unique).toBe(true);
      expect(def?.required).toBe(true);
      // Most-derived explicit value: level 2's min wins.
      expect(def?.min).toBe(5);
    });

    it("preserves `required`, `min`, `max`, `pattern`, `format`, `default` when child restates only the type", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "user_base",
        abstract: true,
        fields: {
          email: {
            type: "string",
            required: true,
            format: "email",
            pattern: "^[^@]+@.+$",
            default: "noreply@example.com",
            min: 3,
            max: 254,
          },
        },
      });
      registry.register({
        name: "user_audit",
        extends: "user_base",
        fields: {
          email: { type: "string", label: "Audited Email" },
        },
      });

      const resolved = registry.resolve("user_audit");
      const def = resolved.fields.email?.definition;

      expect(def?.required).toBe(true);
      expect(def?.format).toBe("email");
      expect(def?.pattern).toBe("^[^@]+@.+$");
      expect(def?.default).toBe("noreply@example.com");
      expect(def?.min).toBe(3);
      expect(def?.max).toBe(254);
      expect(def?.label).toBe("Audited Email");
    });
  });

  describe("implements (interface field injection)", () => {
    it("entity that redeclares an interface field keeps interface's `immutable: true`", () => {
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "auditable",
        label: "Auditable",
        fields: {
          audit_ref: {
            type: "string",
            label: "Audit Reference",
            immutable: true,
            required: true,
          },
        },
      });

      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);
      registry.register({
        name: "audited_doc",
        implements: ["auditable"],
        fields: {
          // Entity restates the field with a different label only.
          audit_ref: { type: "string", label: "Doc Audit Reference" },
        },
      });

      const resolved = registry.resolve("audited_doc");
      const def = resolved.fields.audit_ref?.definition;

      expect(def?.immutable).toBe(true);
      expect(def?.required).toBe(true);
      expect(def?.label).toBe("Doc Audit Reference");
    });

    it("interface field's lockWhen is inherited when entity does not restate it", () => {
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "lockable",
        label: "Lockable",
        fields: {
          state_field: {
            type: "string",
            lockWhen: submittedLock,
          },
        },
      });

      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);
      registry.register({
        name: "lockable_doc",
        implements: ["lockable"],
        fields: {
          state_field: { type: "string" },
        },
      });

      const resolved = registry.resolve("lockable_doc");
      expect(resolved.fields.state_field?.definition.lockWhen).toEqual(submittedLock);
    });
  });

  describe("applyOverride", () => {
    it("override that touches only `label` keeps inherited `immutable: true`", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "po_base",
        abstract: true,
        fields: {
          po_number: { type: "string", immutable: true, required: true },
        },
      });
      registry.register({
        name: "po",
        extends: "po_base",
        fields: {
          po_number: { type: "string" },
        },
      });

      // Override touches a non-constraint property only.
      registry.applyOverride("po", {
        fields: {
          // FieldOverrideProps doesn't include label; use a constraint patch
          // that should not disturb inherited immutability.
          po_number: { unique: true },
        },
      });

      const resolved = registry.resolve("po");
      const def = resolved.fields.po_number?.definition;

      expect(def?.immutable).toBe(true);
      expect(def?.required).toBe(true);
      expect(def?.unique).toBe(true);
    });

    it("override explicitly setting `immutable: false` is respected", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc",
        fields: {
          ref: { type: "string", immutable: true, required: true },
        },
      });

      registry.applyOverride("doc", {
        fields: {
          ref: { immutable: false },
        },
      });

      const resolved = registry.resolve("doc");
      const def = resolved.fields.ref?.definition;

      expect(def?.immutable).toBe(false);
      // Other constraints survive.
      expect(def?.required).toBe(true);
    });

    it("override explicitly setting `lockWhen: undefined` clears the inherited lock", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc",
        fields: {
          notes: { type: "text", lockWhen: submittedLock },
        },
      });

      registry.applyOverride("doc", {
        fields: {
          notes: { lockWhen: undefined },
        },
      });

      const resolved = registry.resolve("doc");
      expect(resolved.fields.notes?.definition.lockWhen).toBeUndefined();
    });

    it("override that tightens lockWhen replaces the inherited condition", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc",
        fields: {
          status_note: { type: "text", lockWhen: submittedLock, immutable: false },
        },
      });

      registry.applyOverride("doc", {
        fields: {
          status_note: { lockWhen: approvedLock },
        },
      });

      const resolved = registry.resolve("doc");
      const def = resolved.fields.status_note?.definition;

      expect(def?.lockWhen).toEqual(approvedLock);
      // Constraints not touched by the override stay.
      expect(def?.immutable).toBe(false);
    });

    it("multiple sequential overrides compose with most-derived explicit value winning", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc",
        fields: {
          score: { type: "number", min: 0, max: 100, immutable: true },
        },
      });

      registry.applyOverride("doc", {
        fields: {
          score: { min: 10 },
        },
      });
      registry.applyOverride("doc", {
        fields: {
          score: { immutable: false, max: 50 },
        },
      });

      const resolved = registry.resolve("doc");
      const def = resolved.fields.score?.definition;

      expect(def?.min).toBe(10); // from first override
      expect(def?.max).toBe(50); // from second override
      expect(def?.immutable).toBe(false); // negated by second override
    });
  });

  describe("applyExtension regression coverage", () => {
    it("extension on a field with the same name keeps inherited constraints unless restated", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc",
        fields: {
          ref: { type: "string", immutable: true, required: true },
        },
      });

      // Extension that replaces the field but only restates the label.
      registry.applyExtension("doc", {
        fields: {
          ref: { type: "string", label: "Doc Ref (Ext)" },
        },
      });

      const resolved = registry.resolve("doc");
      const def = resolved.fields.ref?.definition;

      expect(def?.immutable).toBe(true);
      expect(def?.required).toBe(true);
      expect(def?.label).toBe("Doc Ref (Ext)");
    });
  });
});
