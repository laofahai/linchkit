import { describe, expect, it } from "bun:test";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type {
  FieldDefinition,
  EntityDefinition,
  EntityExtension,
  EntityOverride,
} from "../src/types/entity";

// ── Test fixtures ───────────────────────────────────────

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  presentation: {
    titleField: "name",
    icon: "box",
  },
  fields: {
    name: { type: "string", required: true, label: "Name" },
    price: { type: "number", required: true, min: 0, label: "Price" },
    description: { type: "text", label: "Description" },
    category_id: { type: "string", label: "Category" },
    total_value: {
      type: "computed",
      compute: (r) => (r.price as number) * (r.quantity as number),
      label: "Total Value",
    },
    status: { type: "state", machine: "product_lifecycle", label: "Status" },
    active: { type: "boolean", label: "Active" },
  },
};

const categorySchema: EntityDefinition = {
  name: "category",
  fields: {
    name: { type: "string", required: true },
  },
};

// ── Tests ───────────────────────────────────────────────

describe("EntityRegistry", () => {
  describe("register and get", () => {
    it("registers a schema and retrieves it", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      expect(registry.get("product")).toBe(productSchema);
    });

    it("returns undefined for unregistered schema", () => {
      const registry = createEntityRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("throws on duplicate registration", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      expect(() => registry.register(productSchema)).toThrow(
        'Schema "product" is already registered',
      );
    });

    it("throws on schema without name", () => {
      const registry = createEntityRegistry();
      expect(() => registry.register({ name: "", fields: { x: { type: "string" } } })).toThrow(
        "Schema must have a name",
      );
    });

    it("throws on schema without fields", () => {
      const registry = createEntityRegistry();
      expect(() => registry.register({ name: "empty", fields: {} })).toThrow(
        'Schema "empty" must have at least one field',
      );
    });
  });

  describe("has", () => {
    it("returns true for registered schema", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);
      expect(registry.has("product")).toBe(true);
    });

    it("returns false for unregistered schema", () => {
      const registry = createEntityRegistry();
      expect(registry.has("product")).toBe(false);
    });
  });

  describe("getAll", () => {
    it("returns all registered schemas", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);
      registry.register(categorySchema);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(productSchema);
      expect(all).toContain(categorySchema);
    });

    it("returns empty array when no schemas registered", () => {
      const registry = createEntityRegistry();
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("resolve", () => {
    it("resolves a schema with system fields injected", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const resolved = registry.resolve("product");

      expect(resolved.name).toBe("product");
      expect(resolved.label).toBe("Product");
      expect(resolved.presentation?.titleField).toBe("name");
      expect(resolved.source).toBe(productSchema);

      // System fields present
      expect(resolved.fields.id).toBeDefined();
      expect(resolved.fields.tenant_id).toBeDefined();
      expect(resolved.fields.created_at).toBeDefined();
      expect(resolved.fields.updated_at).toBeDefined();
      expect(resolved.fields.created_by).toBeDefined();
      expect(resolved.fields.updated_by).toBeDefined();
      expect(resolved.fields._version).toBeDefined();
    });

    it("system fields have correct types", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const resolved = registry.resolve("product");

      expect(resolved.fields.id.definition.type).toBe("string");
      expect(resolved.fields.id.definition.required).toBe(true);
      expect(resolved.fields.tenant_id.definition.type).toBe("string");
      expect(resolved.fields.created_at.definition.type).toBe("datetime");
      expect(resolved.fields.updated_at.definition.type).toBe("datetime");
      expect(resolved.fields.created_by.definition.type).toBe("string");
      expect(resolved.fields.updated_by.definition.type).toBe("string");
      expect(resolved.fields._version.definition.type).toBe("number");
    });

    it("marks computed fields as non-storable", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const resolved = registry.resolve("product");

      expect(resolved.fields.total_value.storable).toBe(false);
    });

    it("marks regular fields as storable", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const resolved = registry.resolve("product");

      expect(resolved.fields.name.storable).toBe(true);
      expect(resolved.fields.price.storable).toBe(true);
      expect(resolved.fields.description.storable).toBe(true);
      expect(resolved.fields.category_id.storable).toBe(true);
      expect(resolved.fields.status.storable).toBe(true);
      expect(resolved.fields.active.storable).toBe(true);
    });

    it("uses field label when defined", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const resolved = registry.resolve("product");

      expect(resolved.fields.name.label).toBe("Name");
      expect(resolved.fields.price.label).toBe("Price");
    });

    it("generates label from field name when not defined", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "test",
        fields: {
          first_name: { type: "string" },
          last_name: { type: "string" },
        },
      });

      const resolved = registry.resolve("test");

      expect(resolved.fields.first_name.label).toBe("First Name");
      expect(resolved.fields.last_name.label).toBe("Last Name");
    });

    it("throws when resolving non-existent schema", () => {
      const registry = createEntityRegistry();

      expect(() => registry.resolve("nonexistent")).toThrow(
        'Schema "nonexistent" is not registered',
      );
    });
  });

  describe("applyExtension", () => {
    it("adds new fields from extension", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const extension: EntityExtension = {
        fields: {
          weight: { type: "number", label: "Weight" },
          color: { type: "string", label: "Color" },
        },
      };
      registry.applyExtension("product", extension);

      const resolved = registry.resolve("product");

      expect(resolved.fields.weight).toBeDefined();
      expect(resolved.fields.weight.definition.type).toBe("number");
      expect(resolved.fields.weight.label).toBe("Weight");
      expect(resolved.fields.color).toBeDefined();
    });

    it("throws when extending non-existent schema", () => {
      const registry = createEntityRegistry();

      expect(() =>
        registry.applyExtension("nonexistent", {
          fields: { x: { type: "string" } },
        }),
      ).toThrow('Cannot extend unknown schema "nonexistent"');
    });

    it("supports multiple extensions", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      registry.applyExtension("product", {
        fields: { weight: { type: "number" } },
      });
      registry.applyExtension("product", {
        fields: { color: { type: "string" } },
      });

      const resolved = registry.resolve("product");
      expect(resolved.fields.weight).toBeDefined();
      expect(resolved.fields.color).toBeDefined();
    });
  });

  describe("applyOverride", () => {
    it("modifies field constraints", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      const override: EntityOverride = {
        fields: {
          price: { max: 999999 },
          description: { required: true },
        },
      };
      registry.applyOverride("product", override);

      const resolved = registry.resolve("product");

      expect(resolved.fields.price.definition.max).toBe(999999);
      expect(resolved.fields.description.definition.required).toBe(true);
      // Original constraints preserved
      expect(resolved.fields.price.definition.required).toBe(true);
      expect(resolved.fields.price.definition.min).toBe(0);
    });

    it("throws when overriding non-existent schema", () => {
      const registry = createEntityRegistry();

      expect(() =>
        registry.applyOverride("nonexistent", {
          fields: { x: { required: true } },
        }),
      ).toThrow('Cannot override unknown schema "nonexistent"');
    });

    it("throws when override references unknown field", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      registry.applyOverride("product", {
        fields: { nonexistent_field: { required: true } },
      });

      expect(() => registry.resolve("product")).toThrow(
        'Override references unknown field "nonexistent_field" on schema "product"',
      );
    });

    it("throws when override attempts to change field type", () => {
      const registry = createEntityRegistry();
      registry.register(productSchema);

      registry.applyOverride("product", {
        fields: {
          price: { type: "string" } as unknown as Partial<FieldDefinition>,
        } as EntityOverride["fields"],
      });

      expect(() => registry.resolve("product")).toThrow(
        'Override cannot change the type of field "price" on schema "product"',
      );
    });
  });
});
