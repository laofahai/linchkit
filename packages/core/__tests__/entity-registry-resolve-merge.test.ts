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

  // ── Codex follow-up coverage gaps ───────────────────────────────────────

  describe("readonly inheritance (codex follow-up)", () => {
    it("extends: child preserves parent's `readonly: true` when only label changes", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc_base_ro",
        abstract: true,
        fields: {
          author: { type: "string", readonly: true },
        },
      });
      registry.register({
        name: "doc_ro",
        extends: "doc_base_ro",
        fields: {
          author: { type: "string", label: "Author" },
        },
      });

      const def = registry.resolve("doc_ro").fields.author?.definition;
      expect(def?.readonly).toBe(true);
      expect(def?.label).toBe("Author");
    });

    it("extends: explicit `readonly: false` in child negates parent's readonly", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc_base_ro2",
        abstract: true,
        fields: {
          note: { type: "string", readonly: true },
        },
      });
      registry.register({
        name: "doc_ro2",
        extends: "doc_base_ro2",
        fields: {
          note: { type: "string", readonly: false },
        },
      });

      const def = registry.resolve("doc_ro2").fields.note?.definition;
      expect(def?.readonly).toBe(false);
    });

    it("implements: interface readonly survives entity redeclaration when entity does not restate it", () => {
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "auditable",
        label: "Auditable",
        fields: { author: { type: "string", readonly: true } },
      });
      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);
      registry.register({
        name: "audited_doc",
        implements: ["auditable"],
        fields: {
          author: { type: "string", label: "Original Author" },
        },
      });

      const def = registry.resolve("audited_doc").fields.author?.definition;
      expect(def?.readonly).toBe(true);
      expect(def?.label).toBe("Original Author");
    });

    it("applyOverride: explicit `readonly: false` clears the field's readonly", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc_override_ro",
        fields: {
          status: { type: "string", readonly: true },
        },
      });
      registry.applyOverride("doc_override_ro", {
        fields: { status: { readonly: false } },
      });

      const def = registry.resolve("doc_override_ro").fields.status?.definition;
      expect(def?.readonly).toBe(false);
    });
  });

  describe("non-constraint key regression (codex follow-up)", () => {
    it("child wholly replaces non-mergeable visual / structural keys (label, ui, masking, translatable, derived)", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "doc_visual_base",
        abstract: true,
        fields: {
          summary: {
            type: "string",
            label: "Parent Label",
            ui: { widget: "textarea" },
            masking: { strategy: "redact" },
            translatable: true,
            derived: { from: "raw_summary" },
          },
        },
      });
      registry.register({
        name: "doc_visual",
        extends: "doc_visual_base",
        fields: {
          summary: {
            type: "string",
            label: "Child Label",
          },
        },
      });

      const def = registry.resolve("doc_visual").fields.summary?.definition;
      // Constraint subset (immutable/lockWhen/etc.) — none here, so nothing to preserve.
      // Visual / structural properties: child-wins, so parent values are not carried over.
      expect(def?.label).toBe("Child Label");
      expect(def?.ui).toBeUndefined();
      expect(def?.masking).toBeUndefined();
      expect(def?.translatable).toBeUndefined();
      expect(def?.derived).toBeUndefined();
    });
  });

  describe("interface + extends combined chain (codex follow-up)", () => {
    it("interface metadata propagates transitively through extends", () => {
      // Issue #253: when entity A implements an interface that contributes
      // `immutable: true` on field X, and entity B extends A, B inherits
      // X.immutable from the interface even if B does not list `implements`
      // itself. The inheritance walk seeds each ancestor's `implements`
      // interface fields before its own fields, mirroring the self-implements
      // seed used for the most-derived entity. This keeps interface lock
      // metadata (Spec 63) flowing through `extends` transitively.
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "code_holder",
        label: "Code Holder",
        fields: { code: { type: "string", immutable: true } },
      });
      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "doc_with_code",
        implements: ["code_holder"],
        fields: {
          code: { type: "string", label: "Code" },
        },
      });
      registry.register({
        name: "audited_doc_with_code",
        extends: "doc_with_code",
        fields: {
          code: { type: "string", label: "Audit Code" },
        },
      });

      const directDef = registry.resolve("doc_with_code").fields.code?.definition;
      const indirectDef = registry.resolve("audited_doc_with_code").fields.code?.definition;
      // Direct implementor: interface seeding works — immutable preserved
      expect(directDef?.immutable).toBe(true);
      // Grandchild via `extends` only: interface metadata IS inherited
      // transitively now (issue #253 fix). The grandchild's redeclared label
      // still wins for visual properties.
      expect(indirectDef?.immutable).toBe(true);
      expect(indirectDef?.label).toBe("Audit Code");
    });

    it("workaround for transitive limitation: grandchild that re-declares `implements` does inherit the interface lock", () => {
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "code_holder_2",
        label: "Code Holder 2",
        fields: { code: { type: "string", immutable: true } },
      });
      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "doc_with_code_2",
        implements: ["code_holder_2"],
        fields: { code: { type: "string", label: "Code" } },
      });
      registry.register({
        name: "audited_doc_with_code_2",
        extends: "doc_with_code_2",
        implements: ["code_holder_2"],
        fields: { code: { type: "string", label: "Audit Code" } },
      });

      const def = registry.resolve("audited_doc_with_code_2").fields.code?.definition;
      expect(def?.immutable).toBe(true);
      expect(def?.label).toBe("Audit Code");
    });

    it("multi-interface composition across extends chain combines contributions on shared field set", () => {
      // A implements I1 (code: immutable), B extends A implements I2 (name: readonly).
      // Resolved B must carry BOTH constraints because:
      //   - I1 propagates transitively via A's `implements`
      //   - I2 is seeded from B's own `implements`
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "code_iface",
        label: "Code Iface",
        fields: { code: { type: "string", immutable: true } },
      });
      interfaces.register({
        name: "name_iface",
        label: "Name Iface",
        fields: { name: { type: "string", readonly: true } },
      });

      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "multi_iface_a",
        implements: ["code_iface"],
        fields: {
          code: { type: "string", label: "A Code" },
          name: { type: "string", label: "A Name" },
        },
      });
      registry.register({
        name: "multi_iface_b",
        extends: "multi_iface_a",
        implements: ["name_iface"],
        fields: {
          // B does not restate either constraint key — both must inherit.
          code: { type: "string", label: "B Code" },
          name: { type: "string", label: "B Name" },
        },
      });

      const resolved = registry.resolve("multi_iface_b");
      const codeDef = resolved.fields.code?.definition;
      const nameDef = resolved.fields.name?.definition;

      expect(codeDef?.immutable).toBe(true); // from I1 via ancestor
      expect(codeDef?.label).toBe("B Code");
      expect(nameDef?.readonly).toBe(true); // from I2 directly
      expect(nameDef?.label).toBe("B Name");
    });

    it("three-level chain with mid-level interface: grandchild inherits interface metadata", () => {
      // G (no interfaces) → P (implements I) → C (extends P, no interfaces).
      // C must inherit I's `immutable: true` on `code`.
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "mid_iface",
        label: "Mid Iface",
        fields: { code: { type: "string", immutable: true } },
      });

      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "g_root",
        abstract: true,
        fields: {
          code: { type: "string", label: "G Code" },
        },
      });
      registry.register({
        name: "p_mid",
        extends: "g_root",
        implements: ["mid_iface"],
        fields: {
          code: { type: "string", label: "P Code" },
        },
      });
      registry.register({
        name: "c_leaf",
        extends: "p_mid",
        fields: {
          code: { type: "string", label: "C Code" },
        },
      });

      const def = registry.resolve("c_leaf").fields.code?.definition;
      expect(def?.immutable).toBe(true); // contributed by I via P
      expect(def?.label).toBe("C Code");
    });

    it("override negation through transitive seed: child explicit `immutable: false` wins over interface", () => {
      // A implements I (code: immutable: true). B extends A and redeclares
      // `code: { immutable: false }`. The transitive seed contributes
      // immutable: true from I, but the child's explicit negation must win.
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "lock_iface",
        label: "Lock Iface",
        fields: { code: { type: "string", immutable: true } },
      });

      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "negate_a",
        implements: ["lock_iface"],
        fields: {
          code: { type: "string", label: "A Code" },
        },
      });
      registry.register({
        name: "negate_b",
        extends: "negate_a",
        fields: {
          // Explicit negation: B wants the field mutable even though the
          // interface (via A) declared it immutable.
          code: { type: "string", immutable: false, label: "B Code" },
        },
      });

      const def = registry.resolve("negate_b").fields.code?.definition;
      expect(def?.immutable).toBe(false);
      expect(def?.label).toBe("B Code");
    });

    it("entity explicitly clearing interface-provided lockWhen via undefined wins", () => {
      const interfaces = createInterfaceRegistry();
      interfaces.register({
        name: "lockable",
        label: "Lockable",
        fields: { status: { type: "string", lockWhen: submittedLock } },
      });
      const registry = createEntityRegistry();
      registry.setInterfaceRegistry(interfaces);

      registry.register({
        name: "always_editable",
        implements: ["lockable"],
        fields: {
          status: { type: "string", lockWhen: undefined },
        },
      });

      const def = registry.resolve("always_editable").fields.status?.definition;
      expect(def?.lockWhen).toBeUndefined();
    });
  });

  describe("JSON serialization round-trip (codex follow-up)", () => {
    it("explicit `lockWhen: undefined` survives JSON.parse(JSON.stringify(...)) — i.e. drops the key — and inheritance therefore wins", () => {
      // After JSON round-trip, `{ lockWhen: undefined }` becomes `{}` (the key disappears).
      // That means the child no longer "explicitly restates" lockWhen → parent's lockWhen
      // is inherited. This is the documented behavior: explicit negation requires the key
      // to exist as own property with value `undefined`. Tests pin this contract so a future
      // change can't silently flip it.
      const registry = createEntityRegistry();
      registry.register({
        name: "json_parent",
        abstract: true,
        fields: {
          status: { type: "string", lockWhen: submittedLock, immutable: true },
        },
      });

      const childPayload = JSON.parse(
        JSON.stringify({
          name: "json_child",
          extends: "json_parent",
          fields: {
            status: { type: "string", lockWhen: undefined, label: "Status (post-json)" },
          },
        }),
      );
      registry.register(childPayload);

      const def = registry.resolve("json_child").fields.status?.definition;
      expect(def?.lockWhen).toEqual(submittedLock);
      expect(def?.immutable).toBe(true);
      expect(def?.label).toBe("Status (post-json)");
    });

    it("JSON-cloned `immutable: false` (false survives JSON) still negates", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "json_parent_imm",
        abstract: true,
        fields: { code: { type: "string", immutable: true } },
      });
      const childPayload = JSON.parse(
        JSON.stringify({
          name: "json_child_imm",
          extends: "json_parent_imm",
          fields: { code: { type: "string", immutable: false } },
        }),
      );
      registry.register(childPayload);

      const def = registry.resolve("json_child_imm").fields.code?.definition;
      expect(def?.immutable).toBe(false);
    });
  });

  describe("MERGEABLE_CONSTRAINT_KEYS sync (codex follow-up)", () => {
    it("readonly is mergeable (regression guard for whitelist drift)", () => {
      // Sentinel: if a future refactor accidentally drops `readonly` from the
      // whitelist, this targeted test fails. Pairs with the type-level
      // assertion below.
      const registry = createEntityRegistry();
      registry.register({
        name: "ro_sentinel_base",
        abstract: true,
        fields: { x: { type: "string", readonly: true } },
      });
      registry.register({
        name: "ro_sentinel_child",
        extends: "ro_sentinel_base",
        fields: { x: { type: "string", label: "X" } },
      });
      expect(registry.resolve("ro_sentinel_child").fields.x?.definition.readonly).toBe(true);
    });

    it("lockWhen is mergeable (regression guard for whitelist drift)", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "lw_sentinel_base",
        abstract: true,
        fields: { y: { type: "string", lockWhen: approvedLock } },
      });
      registry.register({
        name: "lw_sentinel_child",
        extends: "lw_sentinel_base",
        fields: { y: { type: "string", label: "Y" } },
      });
      expect(registry.resolve("lw_sentinel_child").fields.y?.definition.lockWhen).toEqual(
        approvedLock,
      );
    });
  });
});
