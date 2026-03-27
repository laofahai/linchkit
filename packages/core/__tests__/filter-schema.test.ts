import { describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "../src/types/schema";
import { filterSchemaByCapabilities } from "../src/capability/filter-schema";

const testSchema: SchemaDefinition = {
  name: "product",
  label: "Product",
  fields: {
    name: { type: "string", required: true },
    price: { type: "number" },
    attachment: {
      type: "string",
      label: "Attachment",
      requiresCapability: "cap-file-storage",
    },
    thumbnail: {
      type: "string",
      label: "Thumbnail",
      requiresCapability: "cap-image",
    },
    description: { type: "text" },
  },
};

describe("filterSchemaByCapabilities", () => {
  test("fields without requiresCapability are always included", () => {
    const result = filterSchemaByCapabilities(testSchema, new Set());
    expect(result.fields).toHaveProperty("name");
    expect(result.fields).toHaveProperty("price");
    expect(result.fields).toHaveProperty("description");
  });

  test("fields with requiresCapability are included when capability is active", () => {
    const caps = new Set(["cap-file-storage", "cap-image"]);
    const result = filterSchemaByCapabilities(testSchema, caps);
    expect(result.fields).toHaveProperty("attachment");
    expect(result.fields).toHaveProperty("thumbnail");
    expect(Object.keys(result.fields)).toHaveLength(5);
  });

  test("fields with requiresCapability are removed when capability is absent", () => {
    const result = filterSchemaByCapabilities(testSchema, new Set());
    expect(result.fields).not.toHaveProperty("attachment");
    expect(result.fields).not.toHaveProperty("thumbnail");
    expect(Object.keys(result.fields)).toHaveLength(3);
  });

  test("partial capability set filters correctly", () => {
    const caps = new Set(["cap-file-storage"]);
    const result = filterSchemaByCapabilities(testSchema, caps);
    expect(result.fields).toHaveProperty("attachment");
    expect(result.fields).not.toHaveProperty("thumbnail");
    expect(Object.keys(result.fields)).toHaveLength(4);
  });

  test("original schema is not mutated", () => {
    const originalFieldCount = Object.keys(testSchema.fields).length;
    filterSchemaByCapabilities(testSchema, new Set());
    expect(Object.keys(testSchema.fields)).toHaveLength(originalFieldCount);
    expect(testSchema.fields).toHaveProperty("attachment");
    expect(testSchema.fields).toHaveProperty("thumbnail");
  });

  test("schema metadata is preserved", () => {
    const result = filterSchemaByCapabilities(testSchema, new Set());
    expect(result.name).toBe("product");
    expect(result.label).toBe("Product");
  });

  test("schema with no dependent fields passes through unchanged", () => {
    const plain: SchemaDefinition = {
      name: "simple",
      fields: {
        title: { type: "string" },
        count: { type: "number" },
      },
    };
    const result = filterSchemaByCapabilities(plain, new Set());
    expect(Object.keys(result.fields)).toHaveLength(2);
  });
});
