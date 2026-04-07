/**
 * Overlay Promotion — unit tests
 *
 * Covers: generateFieldCode for all overlay types, generateMigrationSql
 * produces valid SQL, generatePromotionPlan includes all pieces,
 * constraint handling (min, max, required, enum options).
 */

import { describe, expect, test } from "bun:test";
import {
  generateFieldCode,
  generateMigrationSql,
  generatePromotionPlan,
} from "../src/overlay/promote";
import type { FieldOverlayRecord } from "../src/types/overlay";

/** Helper: create a minimal FieldOverlayRecord for testing */
function makeOverlay(
  overrides: Partial<FieldOverlayRecord> & Pick<FieldOverlayRecord, "fieldName" | "fieldType">,
): FieldOverlayRecord {
  return {
    id: "test-id-001",
    entityName: "purchase_order",
    status: "active",
    config: {},
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

// ── generateFieldCode ─────────────────────────────────────────

describe("generateFieldCode", () => {
  test("string type with label", () => {
    const overlay = makeOverlay({
      fieldName: "nickname",
      fieldType: "string",
      config: { label: { en: "Nickname", "zh-CN": "昵称" }, maxLength: 100 },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain("nickname:");
    expect(code).toContain('type: "string"');
    expect(code).toContain('label: "Nickname"');
    expect(code).toContain("maxLength: 100");
  });

  test("number type with min/max", () => {
    const overlay = makeOverlay({
      fieldName: "score",
      fieldType: "number",
      config: { min: 0, max: 100, label: { en: "Score" } },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('type: "number"');
    expect(code).toContain("min: 0");
    expect(code).toContain("max: 100");
  });

  test("boolean type with default", () => {
    const overlay = makeOverlay({
      fieldName: "is_featured",
      fieldType: "boolean",
      config: { defaultValue: false },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('type: "boolean"');
    expect(code).toContain("default: false");
  });

  test("date type minimal", () => {
    const overlay = makeOverlay({
      fieldName: "expiry_date",
      fieldType: "date",
      config: { label: { en: "Expiry Date" } },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('type: "date"');
    expect(code).toContain('label: "Expiry Date"');
  });

  test("enum type with options", () => {
    const overlay = makeOverlay({
      fieldName: "priority",
      fieldType: "enum",
      config: {
        enumValues: ["low", "medium", "high"],
        label: { en: "Priority" },
        defaultValue: "medium",
      },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('type: "enum"');
    expect(code).toContain('options: ["low","medium","high"]');
    expect(code).toContain('default: "medium"');
  });

  test("json type", () => {
    const overlay = makeOverlay({
      fieldName: "metadata",
      fieldType: "json",
      config: { label: { en: "Metadata" } },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('type: "json"');
    expect(code).toContain('label: "Metadata"');
  });

  test("required field includes required: true", () => {
    const overlay = makeOverlay({
      fieldName: "name",
      fieldType: "string",
      config: { required: true },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain("required: true");
  });

  test("description is included", () => {
    const overlay = makeOverlay({
      fieldName: "notes",
      fieldType: "string",
      config: { description: "Additional notes" },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('description: "Additional notes"');
  });

  test("falls back to first available locale when no en label", () => {
    const overlay = makeOverlay({
      fieldName: "color",
      fieldType: "string",
      config: { label: { "zh-CN": "颜色" } },
    });
    const code = generateFieldCode(overlay);
    expect(code).toContain('label: "颜色"');
  });
});

// ── generateMigrationSql ──────────────────────────────────────

describe("generateMigrationSql", () => {
  test("string field produces TEXT column", () => {
    const overlay = makeOverlay({ fieldName: "nickname", fieldType: "string", config: {} });
    const sql = generateMigrationSql("purchase_order", overlay);
    expect(sql).toContain('ALTER TABLE "purchase_order" ADD COLUMN "nickname" TEXT;');
    expect(sql).toContain("_extensions->>'nickname'");
    expect(sql).toContain("::TEXT");
    expect(sql).toContain("_extensions - 'nickname'");
  });

  test("number field produces DOUBLE PRECISION column", () => {
    const overlay = makeOverlay({ fieldName: "score", fieldType: "number", config: {} });
    const sql = generateMigrationSql("tasks", overlay);
    expect(sql).toContain('"score" DOUBLE PRECISION');
    expect(sql).toContain("::DOUBLE PRECISION");
  });

  test("boolean field produces BOOLEAN column", () => {
    const overlay = makeOverlay({ fieldName: "is_active", fieldType: "boolean", config: {} });
    const sql = generateMigrationSql("users", overlay);
    expect(sql).toContain('"is_active" BOOLEAN');
    expect(sql).toContain("::BOOLEAN");
  });

  test("date field produces TIMESTAMPTZ column", () => {
    const overlay = makeOverlay({ fieldName: "due_date", fieldType: "date", config: {} });
    const sql = generateMigrationSql("tasks", overlay);
    expect(sql).toContain('"due_date" TIMESTAMPTZ');
    expect(sql).toContain("::TIMESTAMPTZ");
  });

  test("enum field produces TEXT column", () => {
    const overlay = makeOverlay({
      fieldName: "status",
      fieldType: "enum",
      config: { enumValues: ["open", "closed"] },
    });
    const sql = generateMigrationSql("tickets", overlay);
    expect(sql).toContain('"status" TEXT');
  });

  test("json field produces JSONB column with -> extraction (not ->>)", () => {
    const overlay = makeOverlay({ fieldName: "meta", fieldType: "json", config: {} });
    const sql = generateMigrationSql("items", overlay);
    expect(sql).toContain('"meta" JSONB');
    expect(sql).toContain("_extensions->'meta'");
    // Should NOT use ->> for JSON (which would stringify)
    expect(sql).not.toContain("_extensions->>'meta'");
  });

  test("required field with default includes NOT NULL DEFAULT", () => {
    const overlay = makeOverlay({
      fieldName: "priority",
      fieldType: "string",
      config: { required: true, defaultValue: "normal" },
    });
    const sql = generateMigrationSql("orders", overlay);
    expect(sql).toContain("NOT NULL DEFAULT 'normal'");
  });

  test("required number with no explicit default uses 0", () => {
    const overlay = makeOverlay({
      fieldName: "count",
      fieldType: "number",
      config: { required: true },
    });
    const sql = generateMigrationSql("items", overlay);
    expect(sql).toContain("NOT NULL DEFAULT 0");
  });

  test("required boolean with no explicit default uses FALSE", () => {
    const overlay = makeOverlay({
      fieldName: "active",
      fieldType: "boolean",
      config: { required: true },
    });
    const sql = generateMigrationSql("items", overlay);
    expect(sql).toContain("NOT NULL DEFAULT FALSE");
  });

  test("all three SQL steps are present", () => {
    const overlay = makeOverlay({ fieldName: "tag", fieldType: "string", config: {} });
    const sql = generateMigrationSql("products", overlay);
    // Step 1: ALTER TABLE
    expect(sql).toContain("ALTER TABLE");
    expect(sql).toContain("ADD COLUMN");
    // Step 2: Backfill
    expect(sql).toContain('SET "tag" =');
    expect(sql).toContain("WHERE _extensions ? 'tag'");
    // Step 3: Cleanup
    expect(sql).toContain("_extensions - 'tag'");
  });

  test("SQL escapes single quotes in default values", () => {
    const overlay = makeOverlay({
      fieldName: "label",
      fieldType: "string",
      config: { required: true, defaultValue: "it's a test" },
    });
    const sql = generateMigrationSql("items", overlay);
    expect(sql).toContain("'it''s a test'");
  });
});

// ── generatePromotionPlan ─────────────────────────────────────

describe("generatePromotionPlan", () => {
  test("includes entityName, fieldName, overlay, code, and SQL", () => {
    const overlay = makeOverlay({
      fieldName: "priority",
      fieldType: "enum",
      config: {
        enumValues: ["low", "medium", "high"],
        label: { en: "Priority" },
      },
    });
    const plan = generatePromotionPlan(overlay);

    expect(plan.entityName).toBe("purchase_order");
    expect(plan.fieldName).toBe("priority");
    expect(plan.overlay).toBe(overlay);

    // Field code
    expect(plan.fieldDefinitionCode).toContain('type: "enum"');
    expect(plan.fieldDefinitionCode).toContain("options:");

    // Migration SQL
    expect(plan.migrationSql).toContain("ALTER TABLE");
    expect(plan.migrationSql).toContain("_extensions");
  });

  test("plan uses entity name from overlay record", () => {
    const overlay = makeOverlay({
      entityName: "invoice",
      fieldName: "tax_rate",
      fieldType: "number",
      config: { min: 0, max: 100 },
    });
    const plan = generatePromotionPlan(overlay);
    expect(plan.entityName).toBe("invoice");
    expect(plan.migrationSql).toContain('"invoice"');
  });
});
