import { describe, expect, it } from "bun:test";
import { planMigration } from "../src/migration/proposal-migration-planner";
import type { MigrationChange } from "../src/migration/proposal-migration-types";

describe("planMigration", () => {
  it("classifies an optional add_column as safe", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "priority",
        definition: { type: "string" },
      },
    ]);
    expect(plan.classification).toBe("safe");
    expect(plan.forward).toHaveLength(1);
    expect(plan.forward[0]?.name).toBe("expand");
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "order" ADD COLUMN "priority" varchar(255) NULL;',
    );
    expect(plan.rollback).toEqual(['ALTER TABLE "order" DROP COLUMN "priority";']);
  });

  it("classifies a required add_column without default as expand", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "supplier_id",
        definition: { type: "string", required: true },
      },
    ]);
    expect(plan.classification).toBe("expand");
    expect(plan.forward[0]?.statements[0]).toContain("NOT NULL");
  });

  it("classifies drop_column as contract and routes to contract phase", () => {
    const change: MigrationChange = {
      kind: "drop_column",
      entity: "order",
      field: "legacy_notes",
      previousDefinition: { type: "string" },
    };
    const plan = planMigration([change]);
    expect(plan.classification).toBe("contract");
    expect(plan.forward[0]?.name).toBe("contract");
    expect(plan.forward[0]?.statements[0]).toBe('ALTER TABLE "order" DROP COLUMN "legacy_notes";');
    // Rollback recreates the column from the previousDefinition
    expect(plan.rollback[0]).toBe(
      'ALTER TABLE "order" ADD COLUMN "legacy_notes" varchar(255) NULL;',
    );
  });

  it("classifies a widening alter_column_type as safe", () => {
    const plan = planMigration([
      {
        kind: "alter_column_type",
        entity: "order",
        field: "note",
        fromType: "string",
        toType: "text",
      },
    ]);
    expect(plan.classification).toBe("safe");
    expect(plan.forward[0]?.name).toBe("migrate");
  });

  it("classifies a narrowing alter_column_type as breaking", () => {
    const plan = planMigration([
      {
        kind: "alter_column_type",
        entity: "order",
        field: "note",
        fromType: "text",
        toType: "string",
      },
    ]);
    expect(plan.classification).toBe("breaking");
  });

  it("routes add_foreign_key to expand phase with REFERENCES clause", () => {
    const plan = planMigration([
      {
        kind: "add_foreign_key",
        entity: "order_line",
        foreignKey: { field: "order_id", toEntity: "order" },
      },
    ]);
    expect(plan.classification).toBe("expand");
    expect(plan.forward[0]?.name).toBe("expand");
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_order_id" ' +
        'FOREIGN KEY ("order_id") REFERENCES "order"("id");',
    );
    // Rollback drops the constraint
    expect(plan.rollback[0]).toBe(
      'ALTER TABLE "order_line" DROP CONSTRAINT "fk_order_line_order_id";',
    );
  });

  it("emits a CREATE TABLE statement for create_table changes", () => {
    const plan = planMigration([
      {
        kind: "create_table",
        entity: "audit_log",
        definition: {
          name: "audit_log",
          fields: {
            id: { type: "string", required: true },
            message: { type: "text" },
          },
        },
      },
    ]);
    expect(plan.classification).toBe("safe");
    expect(plan.forward[0]?.statements[0]).toContain('CREATE TABLE "audit_log"');
    expect(plan.forward[0]?.statements[0]).toContain('"id" varchar(255) NOT NULL');
    expect(plan.forward[0]?.statements[0]).toContain('"message" text NULL');
  });

  it("produces a rename plan with reversible rollback", () => {
    const plan = planMigration([
      {
        kind: "rename_column",
        entity: "order",
        fromField: "supplier",
        toField: "vendor",
        definition: { type: "string" },
      },
    ]);
    expect(plan.classification).toBe("expand");
    expect(plan.forward[0]?.name).toBe("migrate");
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "order" RENAME COLUMN "supplier" TO "vendor";',
    );
    expect(plan.rollback[0]).toBe('ALTER TABLE "order" RENAME COLUMN "vendor" TO "supplier";');
  });

  it("rolls up the worst classification across multiple changes", () => {
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
    expect(plan.classification).toBe("contract");
    expect(plan.forward.map((p) => p.name)).toEqual(["expand", "contract"]);
  });

  it("rejects unsafe SQL identifiers", () => {
    expect(() =>
      planMigration([
        {
          kind: "add_column",
          entity: 'order"; DROP TABLE users;--',
          field: "priority",
          definition: { type: "string" },
        },
      ]),
    ).toThrow(/Unsafe SQL identifier/);
  });

  it("returns an empty plan for an empty change list", () => {
    const plan = planMigration([]);
    expect(plan.classification).toBe("safe");
    expect(plan.forward).toEqual([]);
    expect(plan.rollback).toEqual([]);
    expect(plan.summary).toContain("No schema changes");
  });
});
