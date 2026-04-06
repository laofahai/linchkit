/**
 * Runtime Entity Overlay — unit tests
 *
 * Covers: type validation, InMemoryOverlayStore CRUD, status transitions,
 * duplicate field name prevention, and _extensions column presence.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { InMemoryOverlayStore } from "../src/persistence/in-memory-overlay-store";
import type {
  FieldOverlayDefinition,
  FieldOverlayRecord,
  OverlayFieldConfig,
  OverlayStatus,
} from "../src/types/overlay";
import { buildSystemColumns } from "../src/entity/entity-to-drizzle";

// ── Type validation helpers ─────────────────────────────────

describe("FieldOverlayDefinition type contracts", () => {
  test("valid string overlay definition", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "custom_color",
      fieldType: "string",
      config: {
        label: { en: "Color", "zh-CN": "颜色" },
        description: "Custom color field",
        required: false,
        maxLength: 50,
      },
    };
    expect(def.fieldName).toBe("custom_color");
    expect(def.fieldType).toBe("string");
    expect(def.config.label?.en).toBe("Color");
    expect(def.config.maxLength).toBe(50);
  });

  test("valid number overlay definition with min/max", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "priority_score",
      fieldType: "number",
      config: {
        min: 0,
        max: 100,
        required: true,
        defaultValue: 50,
      },
    };
    expect(def.fieldType).toBe("number");
    expect(def.config.min).toBe(0);
    expect(def.config.max).toBe(100);
    expect(def.config.defaultValue).toBe(50);
  });

  test("valid enum overlay definition", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "size",
      fieldType: "enum",
      config: {
        enumValues: ["small", "medium", "large"],
        defaultValue: "medium",
      },
    };
    expect(def.config.enumValues).toEqual(["small", "medium", "large"]);
  });

  test("valid boolean overlay definition", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "is_featured",
      fieldType: "boolean",
      config: {
        defaultValue: false,
      },
    };
    expect(def.fieldType).toBe("boolean");
  });

  test("valid date overlay definition", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "expiry_date",
      fieldType: "date",
      config: {
        required: true,
      },
    };
    expect(def.fieldType).toBe("date");
  });

  test("valid json overlay definition", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "metadata",
      fieldType: "json",
      config: {
        description: "Arbitrary metadata",
      },
    };
    expect(def.fieldType).toBe("json");
  });

  test("empty config is valid", () => {
    const def: FieldOverlayDefinition = {
      fieldName: "simple_field",
      fieldType: "string",
      config: {},
    };
    expect(def.config).toEqual({});
  });
});

// ── InMemoryOverlayStore CRUD ──────────────────────────────

describe("InMemoryOverlayStore", () => {
  let store: InMemoryOverlayStore;

  beforeEach(() => {
    store = new InMemoryOverlayStore();
  });

  test("addOverlay creates a record with generated id and timestamps", async () => {
    const before = new Date();
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: { min: 1, max: 10 },
      status: "active",
    });

    expect(record.id).toBeDefined();
    expect(record.id).toContain("overlay_");
    expect(record.entityName).toBe("order");
    expect(record.fieldName).toBe("priority");
    expect(record.fieldType).toBe("number");
    expect(record.config).toEqual({ min: 1, max: 10 });
    expect(record.status).toBe("active");
    expect(record.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  test("getOverlays returns only records for the specified entity", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });
    await store.addOverlay({
      entityName: "order",
      fieldName: "notes",
      fieldType: "string",
      config: {},
      status: "active",
    });
    await store.addOverlay({
      entityName: "product",
      fieldName: "weight",
      fieldType: "number",
      config: {},
      status: "active",
    });

    const orderOverlays = await store.getOverlays("order");
    expect(orderOverlays).toHaveLength(2);
    expect(orderOverlays.every((r) => r.entityName === "order")).toBe(true);

    const productOverlays = await store.getOverlays("product");
    expect(productOverlays).toHaveLength(1);
    expect(productOverlays[0]?.fieldName).toBe("weight");
  });

  test("getAllOverlays returns all records", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });
    await store.addOverlay({
      entityName: "product",
      fieldName: "weight",
      fieldType: "number",
      config: {},
      status: "active",
    });

    const all = await store.getAllOverlays();
    expect(all).toHaveLength(2);
  });

  test("getOverlays returns empty array for unknown entity", async () => {
    const result = await store.getOverlays("nonexistent");
    expect(result).toEqual([]);
  });

  test("updateOverlay modifies record fields", async () => {
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: { min: 1 },
      status: "active",
    });

    const updated = await store.updateOverlay(record.id, {
      config: { max: 10 },
    });

    expect(updated.config).toEqual({ min: 1, max: 10 });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(record.updatedAt.getTime());
  });

  test("updateOverlay throws for nonexistent ID", async () => {
    await expect(store.updateOverlay("nonexistent", { status: "deprecated" })).rejects.toThrow(
      "Overlay record not found",
    );
  });

  test("removeOverlay deletes the record", async () => {
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });

    await store.removeOverlay(record.id);
    const all = await store.getAllOverlays();
    expect(all).toHaveLength(0);
  });

  test("removeOverlay throws for nonexistent ID", async () => {
    await expect(store.removeOverlay("nonexistent")).rejects.toThrow("Overlay record not found");
  });

  test("clear removes all records", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });

    store.clear();
    const all = await store.getAllOverlays();
    expect(all).toHaveLength(0);
  });
});

// ── Status transitions ─────────────────────────────────────

describe("OverlayStore status transitions", () => {
  let store: InMemoryOverlayStore;

  beforeEach(() => {
    store = new InMemoryOverlayStore();
  });

  test("active → deprecated", async () => {
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "old_field",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const updated = await store.updateOverlay(record.id, { status: "deprecated" });
    expect(updated.status).toBe("deprecated");
  });

  test("active → promoted", async () => {
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "graduated_field",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const updated = await store.updateOverlay(record.id, { status: "promoted" });
    expect(updated.status).toBe("promoted");
  });

  test("status preserved when updating other fields", async () => {
    const record = await store.addOverlay({
      entityName: "order",
      fieldName: "field_a",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const updated = await store.updateOverlay(record.id, {
      config: { description: "Updated description" },
    });
    expect(updated.status).toBe("active");
  });
});

// ── Duplicate field name prevention ────────────────────────

describe("OverlayStore duplicate prevention", () => {
  let store: InMemoryOverlayStore;

  beforeEach(() => {
    store = new InMemoryOverlayStore();
  });

  test("rejects duplicate (entityName + fieldName) on addOverlay", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });

    await expect(
      store.addOverlay({
        entityName: "order",
        fieldName: "priority",
        fieldType: "string",
        config: {},
        status: "active",
      }),
    ).rejects.toThrow('Overlay field "priority" already exists on entity "order"');
  });

  test("allows same field name on different entities", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });

    const record = await store.addOverlay({
      entityName: "product",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });

    expect(record.entityName).toBe("product");
    expect(record.fieldName).toBe("priority");
  });

  test("rejects rename to existing field name on same entity", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "field_a",
      fieldType: "string",
      config: {},
      status: "active",
    });
    const recordB = await store.addOverlay({
      entityName: "order",
      fieldName: "field_b",
      fieldType: "string",
      config: {},
      status: "active",
    });

    await expect(
      store.updateOverlay(recordB.id, { fieldName: "field_a" }),
    ).rejects.toThrow('Overlay field "field_a" already exists on entity "order"');
  });
});

// ── _extensions system column ──────────────────────────────

describe("_extensions system column", () => {
  test("buildSystemColumns includes _extensions as jsonb", () => {
    const columns = buildSystemColumns();
    expect(columns._extensions).toBeDefined();
  });
});
