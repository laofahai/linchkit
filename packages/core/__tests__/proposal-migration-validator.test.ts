import { describe, expect, it } from "bun:test";
import { planMigration } from "../src/migration/proposal-migration-planner";
import { validateMigrationPlan } from "../src/migration/proposal-migration-validator";

describe("validateMigrationPlan", () => {
  it("returns valid + reversible for a pure additive plan", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "priority",
        definition: { type: "string" },
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.destructive).toBe(false);
    expect(result.reversibility).toBe("reversible");
    expect(result.dataLossSimulationRequired).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("flags drop_column as a destructive error and marks irreversible", () => {
    const plan = planMigration([
      {
        kind: "drop_column",
        entity: "order",
        field: "legacy_notes",
        previousDefinition: { type: "string" },
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.destructive).toBe(true);
    expect(result.reversibility).toBe("irreversible");
    expect(result.dataLossSimulationRequired).toBe(true);
    expect(result.issues.some((i) => i.rule === "destructive_drop_column")).toBe(true);
    expect(result.issues[0]?.reversibility).toBe("irreversible");
  });

  it("flags a lossy alter as breaking + irreversible", () => {
    const plan = planMigration([
      {
        kind: "alter_column_type",
        entity: "order",
        field: "note",
        fromType: "text",
        toType: "string",
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.reversibility).toBe("irreversible");
    expect(result.issues.some((i) => i.rule === "lossy_type_change")).toBe(true);
  });

  it("treats widening alter as safe (no errors, reversible)", () => {
    const plan = planMigration([
      {
        kind: "alter_column_type",
        entity: "order",
        field: "note",
        fromType: "string",
        toType: "text",
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.reversibility).toBe("reversible");
    expect(result.issues).toEqual([]);
  });

  it("warns on add_required_column_without_default but stays valid", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "supplier_id",
        definition: { type: "string", required: true },
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.reversibility).toBe("partial");
    expect(result.issues.some((i) => i.rule === "add_required_column_without_default")).toBe(true);
  });

  it("flags drop_foreign_key as a destructive warning (no error)", () => {
    const plan = planMigration([
      {
        kind: "drop_foreign_key",
        entity: "order_line",
        foreignKey: { field: "order_id", toEntity: "order" },
      },
    ]);
    const result = validateMigrationPlan(plan);
    // No errors — just a warning + destructive flag for integrity loss
    expect(result.valid).toBe(true);
    expect(result.destructive).toBe(true);
    expect(result.dataLossSimulationRequired).toBe(true);
    expect(result.issues.some((i) => i.rule === "drop_foreign_key_relaxes_integrity")).toBe(true);
  });

  it("rename emits an info issue, plan stays valid + reversible", () => {
    const plan = planMigration([
      {
        kind: "rename_column",
        entity: "order",
        fromField: "supplier",
        toField: "vendor",
        definition: { type: "string" },
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.reversibility).toBe("reversible");
    expect(result.issues.some((i) => i.rule === "rename_requires_dual_read")).toBe(true);
  });

  it("aggregates worst reversibility across mixed changes", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "priority",
        definition: { type: "string" },
      },
      {
        kind: "drop_column",
        entity: "order",
        field: "legacy_notes",
        previousDefinition: { type: "string" },
      },
    ]);
    const result = validateMigrationPlan(plan);
    expect(result.reversibility).toBe("irreversible");
    expect(result.destructive).toBe(true);
  });
});
