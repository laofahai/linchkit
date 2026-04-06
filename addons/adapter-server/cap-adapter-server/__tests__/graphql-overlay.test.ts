/**
 * Tests for GraphQL overlay field extension (Phase 3 — Runtime Entity Overlay).
 *
 * Verifies:
 * - Entity type includes overlay fields from OverlayRegistry
 * - Overlay fields resolve from _extensions JSONB
 * - Create/update mutations accept overlay field values
 * - Overlay fields appear in GraphQL introspection
 * - Schema hot-reload after overlay CRUD
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { EntityDefinition, FieldOverlayRecord } from "@linchkit/core";
import { DefaultOverlayRegistry, InMemoryOverlayStore } from "@linchkit/core/server";
import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLString, graphql } from "graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import {
  buildOverlayInputFields,
  buildOverlayOutputFields,
  clearEnumTypeCache,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "../src/graphql/schema-to-graphql";

// Clear cache between tests to avoid cross-test contamination
afterEach(() => {
  clearEnumTypeCache();
});

// ── Test fixtures ────────────────────────────────────────

const orderSchema: EntityDefinition = {
  name: "purchase_order",
  label: "Purchase Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
  },
};

function makeOverlay(
  partial: Partial<FieldOverlayRecord> & {
    fieldName: string;
    fieldType: FieldOverlayRecord["fieldType"];
  },
): FieldOverlayRecord {
  return {
    id: `overlay_${partial.fieldName}`,
    entityName: "purchase_order",
    fieldName: partial.fieldName,
    fieldType: partial.fieldType,
    config: partial.config ?? {},
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

const stringOverlay = makeOverlay({
  fieldName: "priority",
  fieldType: "string",
  config: { description: "Order priority level" },
});

const numberOverlay = makeOverlay({
  fieldName: "score",
  fieldType: "number",
  config: { description: "Priority score", min: 0, max: 100 },
});

const booleanOverlay = makeOverlay({
  fieldName: "is_urgent",
  fieldType: "boolean",
  config: { description: "Whether the order is urgent" },
});

const enumOverlay = makeOverlay({
  fieldName: "category",
  fieldType: "enum",
  config: {
    description: "Order category",
    enumValues: ["office_supplies", "equipment", "services"],
  },
});

const jsonOverlay = makeOverlay({
  fieldName: "metadata_extra",
  fieldType: "json",
  config: { description: "Additional JSON metadata" },
});

const dateOverlay = makeOverlay({
  fieldName: "target_date",
  fieldType: "date",
  config: { description: "Target completion date" },
});

const allOverlays = [
  stringOverlay,
  numberOverlay,
  booleanOverlay,
  enumOverlay,
  jsonOverlay,
  dateOverlay,
];

// ── buildOverlayOutputFields tests ──────────────────────

describe("buildOverlayOutputFields", () => {
  test("maps overlay field types to correct GraphQL types", () => {
    const fields = buildOverlayOutputFields(allOverlays, orderSchema);

    expect(fields.priority.type).toBe(GraphQLString);
    expect(fields.score.type).toBe(GraphQLFloat);
    expect(fields.is_urgent.type).toBe(GraphQLBoolean);
    expect(fields.category.type).toBeInstanceOf(GraphQLEnumType);
    expect(fields.metadata_extra.type).toBe(GraphQLString);
    expect(fields.target_date.type).toBe(GraphQLString);
  });

  test("overlay fields have [Overlay] description prefix", () => {
    const fields = buildOverlayOutputFields([stringOverlay], orderSchema);
    expect(fields.priority.description).toBe("[Overlay] Order priority level");
  });

  test("overlay field resolver reads from _extensions", () => {
    const fields = buildOverlayOutputFields([stringOverlay], orderSchema);
    const resolver = fields.priority.resolve;
    expect(resolver).toBeDefined();

    // Value in _extensions
    const result = resolver?.({
      _extensions: { priority: "high" },
    });
    expect(result).toBe("high");
  });

  test("overlay field resolver falls back to top-level (spread _extensions)", () => {
    const fields = buildOverlayOutputFields([stringOverlay], orderSchema);
    const resolver = fields.priority.resolve;
    expect(resolver).toBeDefined();

    // Value at top level (DataProvider already spread _extensions)
    const result = resolver?.({ priority: "low" });
    expect(result).toBe("low");
  });

  test("overlay field resolver returns null when missing", () => {
    const fields = buildOverlayOutputFields([stringOverlay], orderSchema);
    const resolver = fields.priority.resolve;
    expect(resolver).toBeDefined();
    expect(resolver?.({})).toBeNull();
  });

  test("skips overlay fields that collide with code-defined fields", () => {
    const conflictingOverlay = makeOverlay({
      fieldName: "title",
      fieldType: "string",
    });
    const fields = buildOverlayOutputFields([conflictingOverlay], orderSchema);
    expect(fields.title).toBeUndefined();
  });

  test("skips overlay fields that collide with system fields", () => {
    const conflictingOverlay = makeOverlay({
      fieldName: "created_at",
      fieldType: "string",
    });
    const fields = buildOverlayOutputFields([conflictingOverlay], orderSchema);
    expect(fields.created_at).toBeUndefined();
  });

  test("enum overlay generates GraphQLEnumType with correct values", () => {
    const fields = buildOverlayOutputFields([enumOverlay], orderSchema);
    const enumType = fields.category.type as GraphQLEnumType;
    const values = enumType.getValues().map((v) => v.value);
    expect(values).toContain("office_supplies");
    expect(values).toContain("equipment");
    expect(values).toContain("services");
  });
});

// ── buildOverlayInputFields tests ───────────────────────

describe("buildOverlayInputFields", () => {
  test("all overlay input fields are optional (no NonNull)", () => {
    const fields = buildOverlayInputFields(allOverlays, orderSchema);
    for (const [, field] of Object.entries(fields)) {
      // None should be wrapped in GraphQLNonNull
      expect(field.type).not.toHaveProperty("ofType");
    }
  });

  test("maps overlay types to correct GraphQL input types", () => {
    const fields = buildOverlayInputFields(allOverlays, orderSchema);
    expect(fields.priority.type).toBe(GraphQLString);
    expect(fields.score.type).toBe(GraphQLFloat);
    expect(fields.is_urgent.type).toBe(GraphQLBoolean);
    expect(fields.category.type).toBeInstanceOf(GraphQLEnumType);
  });
});

// ── generateGraphQLObjectType with overlays ─────────────

describe("generateGraphQLObjectType with overlays", () => {
  test("includes overlay fields on the generated object type", () => {
    const objectType = generateGraphQLObjectType(
      orderSchema,
      undefined,
      undefined,
      undefined,
      allOverlays,
    );
    const fields = objectType.getFields();

    // Code-defined fields
    expect(fields.title).toBeDefined();
    expect(fields.amount).toBeDefined();

    // Overlay fields
    expect(fields.priority).toBeDefined();
    expect(fields.score).toBeDefined();
    expect(fields.is_urgent).toBeDefined();
    expect(fields.category).toBeDefined();
    expect(fields.metadata_extra).toBeDefined();
    expect(fields.target_date).toBeDefined();
  });

  test("overlay fields do not override code-defined fields", () => {
    const conflictingOverlay = makeOverlay({
      fieldName: "title",
      fieldType: "number",
    });
    const objectType = generateGraphQLObjectType(orderSchema, undefined, undefined, undefined, [
      conflictingOverlay,
    ]);
    const fields = objectType.getFields();
    // title should still be String (code-defined), not Float (overlay)
    expect(fields.title.type).toBe(GraphQLString);
  });
});

// ── generateGraphQLInputType with overlays ──────────────

describe("generateGraphQLInputType with overlays", () => {
  test("includes overlay fields on the generated input type", () => {
    const inputType = generateGraphQLInputType(orderSchema, undefined, undefined, allOverlays);
    const fields = inputType.getFields();

    // Code-defined fields
    expect(fields.title).toBeDefined();
    expect(fields.amount).toBeDefined();

    // Overlay fields
    expect(fields.priority).toBeDefined();
    expect(fields.score).toBeDefined();
    expect(fields.is_urgent).toBeDefined();
  });
});

// ── buildGraphQLSchema with OverlayRegistry ─────────────

describe("buildGraphQLSchema with overlay registry", () => {
  test("entity type includes overlay fields from registry", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    // Register overlay fields
    await registry.register({
      entityName: "purchase_order",
      fieldName: "priority",
      fieldType: "string",
      config: { description: "Order priority" },
      status: "active",
    });
    await registry.register({
      entityName: "purchase_order",
      fieldName: "score",
      fieldType: "number",
      config: { description: "Priority score" },
      status: "active",
    });

    const schema = buildGraphQLSchema([orderSchema], {
      overlayRegistry: registry,
    });

    // Introspect: overlay fields should appear on PurchaseOrder type
    const result = await graphql({
      schema,
      source: `{
        __type(name: "PurchaseOrder") {
          fields {
            name
            description
            type { name kind }
          }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const typeFields = (result.data as Record<string, Record<string, unknown[]>>).__type
      .fields as Array<{
      name: string;
      description: string;
      type: { name: string };
    }>;
    const fieldNames = typeFields.map((f) => f.name);

    // Code-defined
    expect(fieldNames).toContain("title");
    expect(fieldNames).toContain("amount");
    // Overlay
    expect(fieldNames).toContain("priority");
    expect(fieldNames).toContain("score");

    // Check description prefix
    const priorityField = typeFields.find((f) => f.name === "priority");
    expect(priorityField?.description).toContain("[Overlay]");
  });

  test("overlay fields appear in input type for mutations", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    await registry.register({
      entityName: "purchase_order",
      fieldName: "priority",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const schema = buildGraphQLSchema([orderSchema], {
      overlayRegistry: registry,
    });

    const result = await graphql({
      schema,
      source: `{
        __type(name: "PurchaseOrderInput") {
          inputFields {
            name
            type { name kind }
          }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const inputFields = (result.data as Record<string, Record<string, unknown[]>>).__type
      .inputFields as Array<{ name: string }>;
    const fieldNames = inputFields.map((f) => f.name);
    expect(fieldNames).toContain("priority");
  });

  test("query returns overlay field values from _extensions", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    await registry.register({
      entityName: "purchase_order",
      fieldName: "priority",
      fieldType: "string",
      config: {},
      status: "active",
    });

    // Mock data provider that returns records with _extensions
    const mockDataProvider = {
      get: async () => ({
        id: "order-1",
        title: "Test Order",
        amount: 100,
        tenant_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: null,
        updated_by: null,
        _version: 1,
        _extensions: { priority: "high" },
      }),
      query: async () => [],
      count: async () => 0,
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => {},
    };

    const schema = buildGraphQLSchema([orderSchema], {
      overlayRegistry: registry,
      dataProvider: mockDataProvider as unknown as import("@linchkit/core").DataProvider,
    });

    const result = await graphql({
      schema,
      source: `{
        purchaseOrder(id: "order-1") {
          id
          title
          priority
        }
      }`,
      contextValue: {
        actor: { type: "system", id: "test", groups: [] },
        locale: "en",
      },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.purchaseOrder.priority).toBe("high");
    expect(data.purchaseOrder.title).toBe("Test Order");
  });
});

// ── OverlayRegistry tests ───────────────────────────────

describe("DefaultOverlayRegistry", () => {
  test("initialize loads active overlays from store", async () => {
    const store = new InMemoryOverlayStore();
    await store.addOverlay({
      entityName: "task",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const registry = new DefaultOverlayRegistry(store);
    await registry.initialize();

    const overlays = registry.overlaysFor("task");
    expect(overlays).toHaveLength(1);
    expect(overlays[0].fieldName).toBe("color");
  });

  test("register adds overlay and notifies listeners", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    let notifiedEntity: string | undefined;
    registry.onChange((entityName) => {
      notifiedEntity = entityName;
    });

    await registry.register({
      entityName: "task",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    expect(registry.overlaysFor("task")).toHaveLength(1);
    expect(notifiedEntity).toBe("task");
  });

  test("deprecate removes overlay from cache and notifies listeners", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    const record = await registry.register({
      entityName: "task",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    let notifiedCount = 0;
    registry.onChange(() => {
      notifiedCount++;
    });

    await registry.deprecate(record.id);

    expect(registry.overlaysFor("task")).toHaveLength(0);
    expect(notifiedCount).toBe(1);
  });

  test("onChange returns unsubscribe function", async () => {
    const store = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(store);

    let called = false;
    const unsub = registry.onChange(() => {
      called = true;
    });

    unsub();

    await registry.register({
      entityName: "task",
      fieldName: "x",
      fieldType: "string",
      config: {},
      status: "active",
    });

    expect(called).toBe(false);
  });
});
