import { describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import { generateDefaultViews } from "../src/default-views";

// ── Test fixtures ────────────────────────────────────────

const minimalSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true },
    description: { type: "text" },
    priority: { type: "enum", options: ["low", "medium", "high"] },
  },
};

const schemaWithManyFields: EntityDefinition = {
  name: "product",
  label: "Product",
  fields: {
    name: { type: "string", required: true },
    sku: { type: "string" },
    price: { type: "number" },
    category: { type: "string" },
    brand: { type: "string" },
    color: { type: "string" },
    weight: { type: "number" },
    stock: { type: "number" },
  },
};

const schemaWithSummaryFields: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    order_number: { type: "string", required: true },
    customer: { type: "string" },
    total: { type: "number" },
    status: { type: "string" },
    notes: { type: "text" },
    shipping_address: { type: "text" },
    billing_address: { type: "text" },
  },
  presentation: {
    titleField: "order_number",
    summaryFields: ["order_number", "customer", "total", "status"],
  },
};

const schemaWithSystemFields: EntityDefinition = {
  name: "item",
  label: "Item",
  fields: {
    id: { type: "string" },
    tenant_id: { type: "string" },
    created_at: { type: "datetime" },
    updated_at: { type: "datetime" },
    created_by: { type: "string" },
    updated_by: { type: "string" },
    _version: { type: "number" },
    is_deleted: { type: "boolean" },
    name: { type: "string", required: true },
    value: { type: "number" },
  },
};

const schemaNoLabel: EntityDefinition = {
  name: "raw_entity",
  fields: {
    code: { type: "string" },
  },
};

// ── Tests ────────────────────────────────────────────────

describe("generateDefaultViews", () => {
  test("generates list and form views", () => {
    const views = generateDefaultViews(minimalSchema);
    expect(Object.keys(views)).toEqual(["task_list_default", "task_form_default"]);
  });

  test("list view has correct structure", () => {
    const views = generateDefaultViews(minimalSchema);
    const list = views.task_list_default;

    expect(list.name).toBe("task_list_default");
    expect(list.entity).toBe("task");
    expect(list.type).toBe("list");
    expect(list.label).toBe("Task List");
    expect(list.fields).toEqual([
      { field: "title" },
      { field: "description" },
      { field: "priority" },
    ]);
    expect(list.actions).toEqual([{ action: "create_task", label: "Create", variant: "default" }]);
  });

  test("form view has correct structure", () => {
    const views = generateDefaultViews(minimalSchema);
    const form = views.task_form_default;

    expect(form.name).toBe("task_form_default");
    expect(form.entity).toBe("task");
    expect(form.type).toBe("form");
    expect(form.label).toBe("Task Form");
    expect(form.fields).toEqual([
      { field: "title" },
      { field: "description" },
      { field: "priority" },
    ]);
    expect(form.actions).toEqual([
      { action: "create_task", label: "Create", position: "form-header" },
      { action: "update_task", label: "Save", position: "form-header" },
    ]);
  });

  test("list view caps fields at 6", () => {
    const views = generateDefaultViews(schemaWithManyFields);
    const list = views.product_list_default;

    expect(list.fields).toHaveLength(6);
    expect(list.fields.map((f) => f.field)).toEqual([
      "name",
      "sku",
      "price",
      "category",
      "brand",
      "color",
    ]);
  });

  test("form view includes all non-system fields", () => {
    const views = generateDefaultViews(schemaWithManyFields);
    const form = views.product_form_default;

    expect(form.fields).toHaveLength(8);
    expect(form.fields.map((f) => f.field)).toEqual([
      "name",
      "sku",
      "price",
      "category",
      "brand",
      "color",
      "weight",
      "stock",
    ]);
  });

  test("list view prefers summaryFields from presentation", () => {
    const views = generateDefaultViews(schemaWithSummaryFields);
    const list = views.order_list_default;

    // summaryFields are used first, then padded with remaining
    expect(list.fields.map((f) => f.field)).toEqual([
      "order_number",
      "customer",
      "total",
      "status",
      "notes",
      "shipping_address",
    ]);
  });

  test("excludes system fields from both views", () => {
    const views = generateDefaultViews(schemaWithSystemFields);
    const list = views.item_list_default;
    const form = views.item_form_default;

    const systemNames = [
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
      "is_deleted",
    ];

    for (const view of [list, form]) {
      for (const f of view.fields) {
        expect(systemNames).not.toContain(f.field);
      }
    }
    expect(list.fields.map((f) => f.field)).toEqual(["name", "value"]);
    expect(form.fields.map((f) => f.field)).toEqual(["name", "value"]);
  });

  test("uses schema name as label fallback", () => {
    const views = generateDefaultViews(schemaNoLabel);
    expect(views.raw_entity_list_default.label).toBe("raw_entity List");
    expect(views.raw_entity_form_default.label).toBe("raw_entity Form");
  });

  test("summaryFields referencing non-existent fields are filtered out", () => {
    const schema: EntityDefinition = {
      name: "demo",
      label: "Demo",
      fields: {
        title: { type: "string" },
        body: { type: "text" },
      },
      presentation: {
        summaryFields: ["title", "nonexistent_field"],
      },
    };
    const views = generateDefaultViews(schema);
    const list = views.demo_list_default;
    // nonexistent_field filtered out, body padded in
    expect(list.fields.map((f) => f.field)).toEqual(["title", "body"]);
  });
});
