import { describe, expect, it } from "bun:test";
import {
  buildMigrationSnapshot,
  detectMigrationChanges,
  isTypeWidening,
} from "../src/migration/proposal-migration-detector";
import type { EntitySnapshot } from "../src/migration/proposal-migration-types";

// ── Fixtures ──────────────────────────────────────────────────

function purchaseRequest(): EntitySnapshot {
  return {
    name: "purchase_request",
    fields: {
      id: { type: "string", required: true },
      amount: { type: "number" },
      note: { type: "string" },
    },
  };
}

function supplier(): EntitySnapshot {
  return {
    name: "supplier",
    fields: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("detectMigrationChanges", () => {
  it("emits no changes for identical snapshots", () => {
    const before = buildMigrationSnapshot([purchaseRequest()]);
    const after = buildMigrationSnapshot([purchaseRequest()]);
    expect(detectMigrationChanges({ before, after })).toEqual([]);
  });

  it("detects an added optional column as add_column", () => {
    const before = buildMigrationSnapshot([purchaseRequest()]);
    const afterEntity = purchaseRequest();
    afterEntity.fields.priority = { type: "string" };
    const after = buildMigrationSnapshot([afterEntity]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "add_column",
      entity: "purchase_request",
      field: "priority",
    });
  });

  it("detects a dropped column as drop_column with previousDefinition captured", () => {
    const before = buildMigrationSnapshot([purchaseRequest()]);
    const afterEntity = purchaseRequest();
    delete afterEntity.fields.note;
    const after = buildMigrationSnapshot([afterEntity]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "drop_column",
      entity: "purchase_request",
      field: "note",
      previousDefinition: { type: "string" },
    });
  });

  it("detects an altered column type", () => {
    const beforeEntity = purchaseRequest();
    const afterEntity = purchaseRequest();
    afterEntity.fields.note = { type: "text" };
    const before = buildMigrationSnapshot([beforeEntity]);
    const after = buildMigrationSnapshot([afterEntity]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "alter_column_type",
      entity: "purchase_request",
      field: "note",
      fromType: "string",
      toType: "text",
    });
  });

  it("emits create_table for a brand-new entity", () => {
    const before = buildMigrationSnapshot([purchaseRequest()]);
    const after = buildMigrationSnapshot([purchaseRequest(), supplier()]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("create_table");
  });

  it("emits drop_table for a removed entity", () => {
    const before = buildMigrationSnapshot([purchaseRequest(), supplier()]);
    const after = buildMigrationSnapshot([purchaseRequest()]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "drop_table", entity: "supplier" });
  });

  it("recognises a rename when the rename map is provided", () => {
    const beforeEntity = purchaseRequest();
    const afterEntity = purchaseRequest();
    delete afterEntity.fields.note;
    afterEntity.fields.remarks = { type: "string" };
    const changes = detectMigrationChanges({
      before: buildMigrationSnapshot([beforeEntity]),
      after: buildMigrationSnapshot([afterEntity]),
      renames: { purchase_request: { note: "remarks" } },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "rename_column",
      entity: "purchase_request",
      fromField: "note",
      toField: "remarks",
    });
  });

  it("falls back to drop+add when no rename map is given", () => {
    const beforeEntity = purchaseRequest();
    const afterEntity = purchaseRequest();
    delete afterEntity.fields.note;
    afterEntity.fields.remarks = { type: "string" };
    const changes = detectMigrationChanges({
      before: buildMigrationSnapshot([beforeEntity]),
      after: buildMigrationSnapshot([afterEntity]),
    });
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["add_column", "drop_column"]);
  });

  it("detects FK additions and drops", () => {
    const beforeEntity: EntitySnapshot = {
      ...purchaseRequest(),
      fields: { ...purchaseRequest().fields, supplier_id: { type: "string" } },
    };
    const afterEntity: EntitySnapshot = {
      ...beforeEntity,
      foreignKeys: [{ field: "supplier_id", toEntity: "supplier" }],
    };
    const before = buildMigrationSnapshot([beforeEntity, supplier()]);
    const after = buildMigrationSnapshot([afterEntity, supplier()]);
    const changes = detectMigrationChanges({ before, after });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "add_foreign_key",
      entity: "purchase_request",
    });

    // And the inverse direction:
    const reverse = detectMigrationChanges({ before: after, after: before });
    expect(reverse).toHaveLength(1);
    expect(reverse[0]?.kind).toBe("drop_foreign_key");
  });

  it("isTypeWidening returns true for known widening pairs only", () => {
    expect(isTypeWidening("string", "text")).toBe(true);
    expect(isTypeWidening("date", "datetime")).toBe(true);
    expect(isTypeWidening("number", "number")).toBe(true);
    expect(isTypeWidening("text", "string")).toBe(false);
    expect(isTypeWidening("string", "number")).toBe(false);
  });
});
