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

  // ── DEFAULT rendering (Gemini review #1) ───────────────────

  it("renders a string DEFAULT and escapes embedded single quotes", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "status",
        definition: { type: "string", default: "o'reilly" },
      },
    ]);
    expect(plan.forward[0]?.statements[0]).toBe(
      "ALTER TABLE \"order\" ADD COLUMN \"status\" varchar(255) DEFAULT 'o''reilly' NULL;",
    );
  });

  it("renders numeric and boolean DEFAULTs without quoting", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "qty",
        definition: { type: "number", default: 0 },
      },
      {
        kind: "add_column",
        entity: "order",
        field: "active",
        definition: { type: "boolean", default: true, required: true },
      },
    ]);
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "order" ADD COLUMN "qty" double precision DEFAULT 0 NULL;',
    );
    expect(plan.forward[0]?.statements[1]).toBe(
      'ALTER TABLE "order" ADD COLUMN "active" boolean DEFAULT true NOT NULL;',
    );
  });

  it("renders a JSON DEFAULT as a quoted JSON literal", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "order",
        field: "tags",
        definition: { type: "json", default: { audit: true } },
      },
    ]);
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "order" ADD COLUMN "tags" jsonb DEFAULT \'{"audit":true}\' NULL;',
    );
  });

  // ── UNIQUE constraint (Gemini review #1) ───────────────────

  it("renders a UNIQUE constraint when the field is marked unique", () => {
    const plan = planMigration([
      {
        kind: "add_column",
        entity: "user",
        field: "email",
        definition: { type: "string", required: true, unique: true },
      },
    ]);
    expect(plan.forward[0]?.statements[0]).toBe(
      'ALTER TABLE "user" ADD COLUMN "email" varchar(255) NOT NULL UNIQUE;',
    );
  });

  // ── PRIMARY KEY on id (Gemini review #2) ───────────────────

  it("marks the id column as PRIMARY KEY in CREATE TABLE", () => {
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
    expect(plan.forward[0]?.statements[0]).toContain('"id" varchar(255) NOT NULL PRIMARY KEY');
    // Non-id columns should NOT get PRIMARY KEY appended.
    expect(plan.forward[0]?.statements[0]).toContain('"message" text NULL');
    expect(plan.forward[0]?.statements[0]).not.toContain('"message" text NULL PRIMARY KEY');
  });

  it("throws when a create_table change has no persistable columns", () => {
    expect(() =>
      planMigration([
        {
          kind: "create_table",
          entity: "empty_table",
          definition: {
            name: "empty_table",
            fields: {},
          },
        },
      ]),
    ).toThrow(/Cannot create table empty_table with no columns/);
  });

  it("throws when all columns are filtered out as computed", () => {
    expect(() =>
      planMigration([
        {
          kind: "create_table",
          entity: "all_computed",
          definition: {
            name: "all_computed",
            fields: {
              total: { type: "computed" },
            },
          },
        },
      ]),
    ).toThrow(/Cannot create table all_computed with no columns/);
  });

  // ── Contract-phase ordering (Gemini review #3) ─────────────

  it("emits drop_foreign_key before drop_column and drop_table in the contract phase", () => {
    const plan = planMigration([
      // Detector emits drops in order: drop_table, drop_column, drop_foreign_key
      // The planner must reorder them so FK drops come first, then column drops,
      // then table drops — PostgreSQL otherwise rejects DROP TABLE / COLUMN
      // when a constraint still references it.
      {
        kind: "drop_table",
        entity: "supplier",
        previousDefinition: {
          name: "supplier",
          fields: { id: { type: "string", required: true } },
        },
      },
      {
        kind: "drop_column",
        entity: "order",
        field: "legacy_notes",
        previousDefinition: { type: "string" },
      },
      {
        kind: "drop_foreign_key",
        entity: "order",
        foreignKey: { field: "supplier_id", toEntity: "supplier" },
      },
    ]);
    const contractPhase = plan.forward.find((p) => p.name === "contract");
    expect(contractPhase).toBeDefined();
    expect(contractPhase?.statements).toEqual([
      'ALTER TABLE "order" DROP CONSTRAINT "fk_order_supplier_id";',
      'ALTER TABLE "order" DROP COLUMN "legacy_notes";',
      'DROP TABLE "supplier";',
    ]);
    // The plan's recorded `changes` array preserves the original input order
    // — only the SQL emission within the contract phase is reordered.
    expect(plan.changes.map((c) => c.kind)).toEqual([
      "drop_table",
      "drop_column",
      "drop_foreign_key",
    ]);
  });

  it("preserves non-contract order while reordering only the contract block", () => {
    const plan = planMigration([
      {
        kind: "drop_table",
        entity: "supplier",
        previousDefinition: {
          name: "supplier",
          fields: { id: { type: "string", required: true } },
        },
      },
      {
        kind: "add_column",
        entity: "order",
        field: "priority",
        definition: { type: "string" },
      },
      {
        kind: "drop_foreign_key",
        entity: "order",
        foreignKey: { field: "supplier_id", toEntity: "supplier" },
      },
    ]);
    // expand phase keeps the lone add_column; contract phase reorders FK → table.
    const expandPhase = plan.forward.find((p) => p.name === "expand");
    const contractPhase = plan.forward.find((p) => p.name === "contract");
    expect(expandPhase?.statements).toEqual([
      'ALTER TABLE "order" ADD COLUMN "priority" varchar(255) NULL;',
    ]);
    expect(contractPhase?.statements).toEqual([
      'ALTER TABLE "order" DROP CONSTRAINT "fk_order_supplier_id";',
      'DROP TABLE "supplier";',
    ]);
  });
});
