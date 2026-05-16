import { describe, expect, it } from "bun:test";
import {
  buildCompatibilitySnapshot,
  type CompatibilityRegistrySnapshot,
} from "../src/ai/proposal-compatibility-checker";
import { dryRunProposal } from "../src/ai/proposal-dry-run";
import type { EntityDefinition } from "../src/types/entity";

// ── Fixtures ──────────────────────────────────────────────────

function makeProductEntity(): EntityDefinition {
  return {
    name: "product",
    fields: {
      id: { type: "string", required: true },
      sku: { type: "string" },
      price: { type: "number" },
    },
  };
}

function makeCategoryEntity(): EntityDefinition {
  return {
    name: "category",
    fields: {
      id: { type: "string", required: true },
      name: { type: "string" },
    },
  };
}

function makeSnapshot(): CompatibilityRegistrySnapshot {
  return buildCompatibilitySnapshot([makeProductEntity(), makeCategoryEntity()], []);
}

// ── Happy path ───────────────────────────────────────────────

describe("dryRunProposal — happy path", () => {
  it("applies a clean add-field change and reports ok=true", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal(
      [
        {
          kind: "field_add",
          entity: "product",
          field: "currency",
          definition: { type: "string" },
        },
      ],
      snapshot,
    );
    expect(result.ok).toBe(true);
    expect(result.modelErrors).toHaveLength(0);
    expect(result.sideEffects.fieldsAdded).toBe(1);
    expect(result.sideEffects.entitiesModified).toBe(1);
  });

  it("counts add/remove/modify side effects accurately", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal(
      [
        {
          kind: "entity_create",
          entity: "warehouse",
          definition: {
            name: "warehouse",
            fields: { id: { type: "string", required: true } },
          },
        },
        { kind: "entity_delete", entity: "category" },
        {
          kind: "field_add",
          entity: "product",
          field: "weight",
          definition: { type: "number" },
        },
        { kind: "field_drop", entity: "product", field: "sku" },
        {
          kind: "field_type_change",
          entity: "product",
          field: "price",
          newType: "number",
        },
      ],
      snapshot,
    );
    expect(result.sideEffects.entitiesAdded).toBe(1);
    expect(result.sideEffects.entitiesRemoved).toBe(1);
    expect(result.sideEffects.entitiesModified).toBe(1); // only product was field-modified
    expect(result.sideEffects.fieldsAdded).toBe(1);
    expect(result.sideEffects.fieldsRemoved).toBe(1);
    expect(result.sideEffects.fieldsModified).toBe(1);
    expect(result.postStateEntityCount).toBe(2); // product + warehouse
  });

  it("renames an entity and rewrites references", () => {
    const snapshot = buildCompatibilitySnapshot(
      [makeProductEntity(), makeCategoryEntity()],
      [
        {
          fromEntity: "product",
          fromField: "id",
          toEntity: "category",
          toField: "id",
        },
      ],
    );
    const result = dryRunProposal(
      [{ kind: "entity_rename", entity: "category", newName: "product_group" }],
      snapshot,
    );
    expect(result.ok).toBe(true);
    expect(result.sideEffects.entitiesRenamed).toBe(1);
  });
});

// ── Drift detection ──────────────────────────────────────────

describe("dryRunProposal — drift / error detection", () => {
  it("flags duplicate entity creation as a model error", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal(
      [
        {
          kind: "entity_create",
          entity: "product", // already exists
          definition: {
            name: "product",
            fields: { id: { type: "string", required: true } },
          },
        },
      ],
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.modelErrors[0].code).toBe("duplicate_entity");
  });

  it("flags missing entity on delete as a model error", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal([{ kind: "entity_delete", entity: "nonexistent" }], snapshot);
    expect(result.ok).toBe(false);
    expect(result.modelErrors[0].code).toBe("missing_entity");
  });

  it("flags missing field on drop as a model error", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal(
      [{ kind: "field_drop", entity: "product", field: "ghost" }],
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.modelErrors[0].code).toBe("missing_field");
  });

  it("detects dangling references after entity rename target collision", () => {
    const snapshot = buildCompatibilitySnapshot([makeProductEntity(), makeCategoryEntity()], []);
    const result = dryRunProposal(
      [{ kind: "entity_rename", entity: "product", newName: "category" }],
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.modelErrors[0].code).toBe("duplicate_entity");
  });

  it("detects dangling reference target after a field drop", () => {
    // Reference to category.label which we then drop
    const snapshot: CompatibilityRegistrySnapshot = {
      entities: {
        product: {
          name: "product",
          fields: {
            id: { type: "string", required: true },
            cat_label: { type: "string" },
          },
        },
        category: {
          name: "category",
          fields: {
            id: { type: "string", required: true },
            label: { type: "string" },
          },
        },
      },
      references: [
        {
          fromEntity: "product",
          fromField: "cat_label",
          toEntity: "category",
          toField: "label",
        },
      ],
    };
    const result = dryRunProposal(
      [{ kind: "field_drop", entity: "category", field: "label" }],
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result.modelErrors.some((e) => e.code === "dangling_reference_to_field")).toBe(true);
  });
});

// ── Snapshot isolation ────────────────────────────────────────

describe("dryRunProposal — snapshot isolation", () => {
  it("does not mutate the caller's snapshot after a destructive change", () => {
    const snapshot = makeSnapshot();
    const before = JSON.stringify(snapshot);
    dryRunProposal(
      [
        { kind: "entity_delete", entity: "category" },
        { kind: "field_drop", entity: "product", field: "sku" },
      ],
      snapshot,
    );
    const after = JSON.stringify(snapshot);
    expect(after).toBe(before);
  });

  it("does not mutate field options when enum is changed", () => {
    const snapshot: CompatibilityRegistrySnapshot = {
      entities: {
        product: {
          name: "product",
          fields: {
            id: { type: "string", required: true },
            status: {
              type: "enum",
              options: [{ value: "active" }, { value: "archived" }],
            },
          },
        },
      },
    };
    const before = JSON.stringify(snapshot);
    dryRunProposal(
      [
        {
          kind: "enum_options_change",
          entity: "product",
          field: "status",
          newOptions: ["active"],
        },
      ],
      snapshot,
    );
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("reports snapshotPreserved=true on success", () => {
    const snapshot = makeSnapshot();
    const result = dryRunProposal(
      [
        {
          kind: "field_add",
          entity: "product",
          field: "tax",
          definition: { type: "number" },
        },
      ],
      snapshot,
    );
    expect(result.snapshotPreserved).toBe(true);
  });
});
