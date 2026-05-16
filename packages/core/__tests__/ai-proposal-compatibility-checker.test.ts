import { describe, expect, it } from "bun:test";
import {
  buildCompatibilitySnapshot,
  type CompatibilityRegistrySnapshot,
  compatibilityCheck,
} from "../src/ai/proposal-compatibility-checker";
import type { EntityDefinition } from "../src/types/entity";

// ── Fixtures ──────────────────────────────────────────────────

function makeOrderEntity(): EntityDefinition {
  return {
    name: "order",
    fields: {
      id: { type: "string", required: true },
      status: {
        type: "enum",
        options: [{ value: "draft" }, { value: "submitted" }, { value: "approved" }],
      },
      amount: { type: "number", min: 0, max: 10000 },
      note: { type: "string" },
    },
  };
}

function makeLineItemEntity(): EntityDefinition {
  return {
    name: "line_item",
    fields: {
      id: { type: "string", required: true },
      order_id: { type: "string", required: true },
      qty: { type: "number" },
    },
  };
}

function makeSnapshot(): CompatibilityRegistrySnapshot {
  return buildCompatibilitySnapshot(
    [makeOrderEntity(), makeLineItemEntity()],
    [
      // line_item.order_id → order.id
      { fromEntity: "line_item", fromField: "order_id", toEntity: "order", toField: "id" },
    ],
  );
}

// ── Phase 3 — happy path ─────────────────────────────────────

describe("compatibilityCheck — happy path", () => {
  it("flags an entity create as info only", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "entity_create",
          entity: "audit_log",
          definition: {
            name: "audit_log",
            fields: { id: { type: "string", required: true } },
          },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
    expect(result.info.some((i) => i.rule === "entity_added")).toBe(true);
  });

  it("flags an optional field add as info only", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_add",
          entity: "order",
          field: "tags",
          definition: { type: "string" },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(true);
    expect(result.info.some((i) => i.rule === "field_added")).toBe(true);
  });

  it("allows compatible type widening (string → text, date → datetime)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [{ kind: "field_type_change", entity: "order", field: "note", newType: "text" }],
      snapshot,
    );
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
  });
});

// ── Phase 3 — breaking-change rules (one per rule) ───────────

describe("compatibilityCheck — breaking-change rules", () => {
  it("detects dropping a field that has live FK references (drop_field_with_references)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [{ kind: "field_drop", entity: "order", field: "id" }],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("drop_field_with_references");
    expect(result.breaking[0].reason).toContain("FK references");
  });

  it("detects incompatible field type change (incompatible_field_type_change)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [{ kind: "field_type_change", entity: "order", field: "amount", newType: "boolean" }],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("incompatible_field_type_change");
  });

  it("detects deleting an entity that has FK references (delete_entity_with_references)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck([{ kind: "entity_delete", entity: "order" }], snapshot);
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("delete_entity_with_references");
  });

  it("detects renaming an entity that has FK references (rename_entity_with_references)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [{ kind: "entity_rename", entity: "order", newName: "purchase_order" }],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("rename_entity_with_references");
  });

  it("detects tightening nullable → required (tighten_constraint_nullable_to_required)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "order",
          field: "note",
          patch: { required: true },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_nullable_to_required");
  });

  it("detects adding a unique constraint (tighten_constraint_add_unique)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "order",
          field: "note",
          patch: { unique: true },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_add_unique");
  });

  it("detects narrowing min upward (tighten_constraint_narrow_min)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "order",
          field: "amount",
          patch: { min: 100 },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_narrow_min");
  });

  it("detects introducing a min where none existed (tighten_constraint_narrow_min)", () => {
    // `qty` on line_item has no min/max — adding a min must be breaking
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "line_item",
          field: "qty",
          patch: { min: 1 },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_narrow_min");
    expect(result.breaking[0].reason).toContain("Adding a min");
  });

  it("detects narrowing max downward (tighten_constraint_narrow_max)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "order",
          field: "amount",
          patch: { max: 100 },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_narrow_max");
  });

  it("detects introducing a max where none existed (tighten_constraint_narrow_max)", () => {
    // `qty` on line_item has no min/max — adding a max must be breaking
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_constraint_change",
          entity: "line_item",
          field: "qty",
          patch: { max: 1000 },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_narrow_max");
    expect(result.breaking[0].reason).toContain("Adding a max");
  });

  it("detects narrowing an enum (tighten_constraint_narrow_enum)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "enum_options_change",
          entity: "order",
          field: "status",
          newOptions: ["draft", "submitted"], // removed "approved"
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("tighten_constraint_narrow_enum");
    expect(result.breaking[0].reason).toContain("approved");
  });

  it("detects adding a required field without default (add_required_field_without_default)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_add",
          entity: "order",
          field: "currency",
          definition: { type: "string", required: true },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking[0].rule).toBe("add_required_field_without_default");
  });
});

// ── Phase 3 — warnings and info ──────────────────────────────

describe("compatibilityCheck — warnings", () => {
  it("warns on dropping a field that has no FK references (data loss warning)", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [{ kind: "field_drop", entity: "order", field: "note" }],
      snapshot,
    );
    expect(result.compatible).toBe(true);
    expect(result.warnings.some((w) => w.rule === "drop_field_data_loss")).toBe(true);
  });

  it("warns on deleting an entity that has no incoming references", () => {
    const snapshot = makeSnapshot();
    // Remove the line_item → order ref so deleting order is non-breaking
    snapshot.references = [];
    const result = compatibilityCheck([{ kind: "entity_delete", entity: "order" }], snapshot);
    expect(result.compatible).toBe(true);
    expect(result.warnings.some((w) => w.rule === "delete_entity_data_loss")).toBe(true);
  });

  it("emits an info note when a field is dropped and re-added (replacement)", () => {
    const snapshot = makeSnapshot();
    snapshot.references = [];
    const result = compatibilityCheck(
      [
        { kind: "field_drop", entity: "order", field: "note" },
        {
          kind: "field_add",
          entity: "order",
          field: "note",
          definition: { type: "text" },
        },
      ],
      snapshot,
    );
    expect(result.info.some((i) => i.rule === "field_drop_and_readd")).toBe(true);
  });

  it("matches each drop/re-add pair exactly once across many changes", () => {
    // Exercises the two-pass Map index — three drop/add pairs should yield
    // exactly three `field_drop_and_readd` notes (one per pair), proving the
    // index does not double-count when many changes are present.
    const snapshot = makeSnapshot();
    snapshot.references = [];
    const result = compatibilityCheck(
      [
        { kind: "field_drop", entity: "order", field: "note" },
        { kind: "field_drop", entity: "order", field: "amount" },
        { kind: "field_drop", entity: "line_item", field: "qty" },
        {
          kind: "field_add",
          entity: "order",
          field: "note",
          definition: { type: "text" },
        },
        {
          kind: "field_add",
          entity: "order",
          field: "amount",
          definition: { type: "number" },
        },
        {
          kind: "field_add",
          entity: "line_item",
          field: "qty",
          definition: { type: "number" },
        },
      ],
      snapshot,
    );
    const replacements = result.info.filter((i) => i.rule === "field_drop_and_readd");
    expect(replacements).toHaveLength(3);
  });
});

// ── Phase 3 — adding a required field with a default is OK ───

describe("compatibilityCheck — required field with default", () => {
  it("does not flag a required field that has a default", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        {
          kind: "field_add",
          entity: "order",
          field: "currency",
          definition: { type: "string", required: true, default: "USD" },
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
    expect(result.info.some((i) => i.rule === "field_added")).toBe(true);
  });
});

// ── Phase 3 — multiple changes ───────────────────────────────

describe("compatibilityCheck — aggregation", () => {
  it("reports multiple breaking issues from a multi-change proposal", () => {
    const snapshot = makeSnapshot();
    const result = compatibilityCheck(
      [
        { kind: "field_drop", entity: "order", field: "id" }, // breaking
        {
          kind: "enum_options_change",
          entity: "order",
          field: "status",
          newOptions: ["draft"], // narrowing
        },
      ],
      snapshot,
    );
    expect(result.compatible).toBe(false);
    expect(result.breaking.length).toBeGreaterThanOrEqual(2);
  });
});
