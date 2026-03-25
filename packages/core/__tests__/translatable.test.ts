import { describe, expect, test } from "bun:test";
import {
  createTranslatableValue,
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
  validateTranslatableSchema,
  wrapTranslatableValue,
} from "../src/schema/translatable";
import type { SchemaDefinition } from "../src/types/schema";

describe("resolveTranslatableValue", () => {
  test("returns undefined for null/undefined input", () => {
    expect(resolveTranslatableValue(null)).toBeUndefined();
    expect(resolveTranslatableValue(undefined)).toBeUndefined();
  });

  test("returns plain string as-is", () => {
    expect(resolveTranslatableValue("hello")).toBe("hello");
  });

  test("exact locale match", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(resolveTranslatableValue(value, "en")).toBe("Hello");
    expect(resolveTranslatableValue(value, "zh-CN")).toBe("你好");
  });

  test("language prefix match (zh matches zh-CN)", () => {
    const value = { "zh-CN": "你好", en: "Hello" };
    expect(resolveTranslatableValue(value, "zh")).toBe("你好");
  });

  test("language prefix match (en matches en-US)", () => {
    const value = { "en-US": "Hello", "zh-CN": "你好" };
    expect(resolveTranslatableValue(value, "en")).toBe("Hello");
  });

  test("falls back to default locale", () => {
    const value = { "zh-CN": "你好", en: "Hello" };
    expect(resolveTranslatableValue(value, "ja", "zh-CN")).toBe("你好");
  });

  test("falls back to first available value", () => {
    const value = { "zh-CN": "你好", en: "Hello" };
    expect(resolveTranslatableValue(value, "ja", "fr")).toBe("你好");
  });

  test("returns undefined for empty object", () => {
    expect(resolveTranslatableValue({})).toBeUndefined();
  });

  test("returns undefined for non-object non-string", () => {
    expect(resolveTranslatableValue(42)).toBeUndefined();
  });

  test("no locale requested returns first available", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(resolveTranslatableValue(value)).toBe("Hello");
  });
});

describe("wrapTranslatableValue", () => {
  test("wraps a plain string with the given locale", () => {
    expect(wrapTranslatableValue("Hello", "en")).toEqual({ en: "Hello" });
  });

  test("wraps with a region locale", () => {
    expect(wrapTranslatableValue("你好", "zh-CN")).toEqual({ "zh-CN": "你好" });
  });

  test("wraps empty string", () => {
    expect(wrapTranslatableValue("", "en")).toEqual({ en: "" });
  });
});

describe("mergeTranslatableValue", () => {
  test("merges a new locale into an existing map", () => {
    const existing = { en: "Hello" };
    const result = mergeTranslatableValue(existing, "你好", "zh-CN");
    expect(result).toEqual({ en: "Hello", "zh-CN": "你好" });
  });

  test("overwrites an existing locale", () => {
    const existing = { en: "Hello", "zh-CN": "旧值" };
    const result = mergeTranslatableValue(existing, "新值", "zh-CN");
    expect(result).toEqual({ en: "Hello", "zh-CN": "新值" });
  });

  test("creates new map from null existing", () => {
    const result = mergeTranslatableValue(null, "Hello", "en");
    expect(result).toEqual({ en: "Hello" });
  });

  test("creates new map from undefined existing", () => {
    const result = mergeTranslatableValue(undefined, "Hello", "en");
    expect(result).toEqual({ en: "Hello" });
  });

  test("does not mutate the original object", () => {
    const existing = { en: "Hello" };
    const result = mergeTranslatableValue(existing, "你好", "zh-CN");
    expect(existing).toEqual({ en: "Hello" }); // unchanged
    expect(result).toEqual({ en: "Hello", "zh-CN": "你好" });
  });
});

describe("normalizeTranslatableValue", () => {
  test("wraps plain string with default locale", () => {
    expect(normalizeTranslatableValue("Hello", "en")).toEqual({ en: "Hello" });
  });

  test("passes through locale map as-is", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(normalizeTranslatableValue(value, "en")).toEqual(value);
  });

  test("passes through null", () => {
    expect(normalizeTranslatableValue(null, "en")).toBeNull();
  });

  test("passes through undefined", () => {
    expect(normalizeTranslatableValue(undefined, "en")).toBeUndefined();
  });
});

describe("getTranslatableFields", () => {
  test("returns empty set for schema without translatable fields", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        title: { type: "string" },
        count: { type: "number" },
      },
    };
    expect(getTranslatableFields(schema).size).toBe(0);
  });

  test("returns translatable field names", () => {
    const schema: SchemaDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        name: { type: "string", translatable: true },
        description: { type: "text", translatable: true },
        sku: { type: "string" },
        price: { type: "number" },
      },
    };
    const fields = getTranslatableFields(schema);
    expect(fields.size).toBe(2);
    expect(fields.has("name")).toBe(true);
    expect(fields.has("description")).toBe(true);
    expect(fields.has("sku")).toBe(false);
  });
});

// -- Row-level helpers --

const productSchema: SchemaDefinition = {
  name: "product",
  i18n: { defaultLocale: "en", supportedLocales: ["en", "zh-CN"] },
  fields: {
    name: { type: "string", translatable: true },
    description: { type: "text", translatable: true },
    sku: { type: "string" },
    price: { type: "number" },
  },
};

const plainSchema: SchemaDefinition = {
  name: "counter",
  fields: {
    label: { type: "string" },
    count: { type: "number" },
  },
};

describe("resolveTranslatableRow", () => {
  test("resolves translatable fields to locale string", () => {
    const row = {
      name: { en: "Widget", "zh-CN": "小部件" },
      description: { en: "A useful widget", "zh-CN": "一个有用的小部件" },
      sku: "W-001",
      price: 9.99,
    };
    const result = resolveTranslatableRow(row, productSchema, "zh-CN");
    expect(result.name).toBe("小部件");
    expect(result.description).toBe("一个有用的小部件");
    expect(result.sku).toBe("W-001");
    expect(result.price).toBe(9.99);
  });

  test("uses default locale as fallback", () => {
    const row = {
      name: { en: "Widget" },
      description: { en: "A useful widget" },
      sku: "W-001",
      price: 9.99,
    };
    const result = resolveTranslatableRow(row, productSchema, "ja");
    expect(result.name).toBe("Widget"); // falls back to defaultLocale "en"
    expect(result.description).toBe("A useful widget");
  });

  test("returns row unchanged when schema has no translatable fields", () => {
    const row = { label: "test", count: 42 };
    const result = resolveTranslatableRow(row, plainSchema, "en");
    expect(result).toBe(row); // same reference
  });

  test("handles missing translatable fields in row", () => {
    const row = { sku: "W-001", price: 9.99 };
    const result = resolveTranslatableRow(row, productSchema, "en");
    expect(result.sku).toBe("W-001");
    expect(result.name).toBeUndefined();
  });
});

describe("normalizeTranslatableRow", () => {
  test("wraps plain strings into JSONB format", () => {
    const row = {
      name: "Widget",
      description: "A useful widget",
      sku: "W-001",
      price: 9.99,
    };
    const result = normalizeTranslatableRow(row, productSchema, "en");
    expect(result.name).toEqual({ en: "Widget" });
    expect(result.description).toEqual({ en: "A useful widget" });
    expect(result.sku).toBe("W-001");
    expect(result.price).toBe(9.99);
  });

  test("passes through existing locale maps", () => {
    const row = {
      name: { en: "Widget", "zh-CN": "小部件" },
      sku: "W-001",
    };
    const result = normalizeTranslatableRow(row, productSchema, "en");
    expect(result.name).toEqual({ en: "Widget", "zh-CN": "小部件" });
  });

  test("uses schema default locale when no locale provided", () => {
    const row = { name: "Widget", sku: "W-001" };
    const result = normalizeTranslatableRow(row, productSchema);
    expect(result.name).toEqual({ en: "Widget" }); // schema defaultLocale is "en"
  });

  test("falls back to 'en' when no locale and no schema default", () => {
    const noI18nSchema: SchemaDefinition = {
      name: "test",
      fields: {
        title: { type: "string", translatable: true },
      },
    };
    const row = { title: "Hello" };
    const result = normalizeTranslatableRow(row, noI18nSchema);
    expect(result.title).toEqual({ en: "Hello" });
  });

  test("returns row unchanged when schema has no translatable fields", () => {
    const row = { label: "test", count: 42 };
    const result = normalizeTranslatableRow(row, plainSchema, "en");
    expect(result).toBe(row); // same reference
  });
});

// -- createTranslatableValue --

describe("createTranslatableValue", () => {
  test("creates a translatable value from a translations object", () => {
    const result = createTranslatableValue({ en: "Hello", "zh-CN": "你好" });
    expect(result).toEqual({ en: "Hello", "zh-CN": "你好" });
  });

  test("creates a copy (does not mutate input)", () => {
    const input = { en: "Hello" };
    const result = createTranslatableValue(input);
    result["zh-CN"] = "你好";
    expect(input).toEqual({ en: "Hello" }); // unchanged
  });

  test("handles single locale", () => {
    const result = createTranslatableValue({ en: "Hello" });
    expect(result).toEqual({ en: "Hello" });
  });
});

// -- resolveTranslation --

describe("resolveTranslation", () => {
  test("resolves exact locale match", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(resolveTranslation(value, "en")).toBe("Hello");
    expect(resolveTranslation(value, "zh-CN")).toBe("你好");
  });

  test("resolves with language prefix fallback", () => {
    const value = { "zh-CN": "你好", en: "Hello" };
    expect(resolveTranslation(value, "zh")).toBe("你好");
  });

  test("returns empty string when no match found", () => {
    const value = {};
    expect(resolveTranslation(value, "ja")).toBe("");
  });

  test("uses fallback locale", () => {
    const value = { "zh-CN": "你好", en: "Hello" };
    expect(resolveTranslation(value, "ja", "en")).toBe("Hello");
  });
});

// -- validateTranslatableSchema --

describe("validateTranslatableSchema", () => {
  test("returns no errors for valid schema", () => {
    const schema: SchemaDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        name: { type: "string", translatable: true },
        description: { type: "text", translatable: true },
        sku: { type: "string" },
      },
    };
    expect(validateTranslatableSchema(schema)).toEqual([]);
  });

  test("returns no errors for schema without translatable fields", () => {
    const schema: SchemaDefinition = {
      name: "counter",
      fields: {
        count: { type: "number" },
      },
    };
    expect(validateTranslatableSchema(schema)).toEqual([]);
  });

  test("returns error for non-translatable field type with translatable flag", () => {
    const schema: SchemaDefinition = {
      name: "test",
      i18n: { defaultLocale: "en" },
      fields: {
        count: { type: "number", translatable: true },
      },
    };
    const errors = validateTranslatableSchema(schema);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("count");
    expect(errors[0]).toContain("number");
  });

  test("returns error for boolean field with translatable flag", () => {
    const schema: SchemaDefinition = {
      name: "test",
      i18n: { defaultLocale: "en" },
      fields: {
        active: { type: "boolean", translatable: true },
      },
    };
    const errors = validateTranslatableSchema(schema);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("active");
    expect(errors[0]).toContain("boolean");
  });

  test("returns error when translatable fields exist but no defaultLocale", () => {
    const schema: SchemaDefinition = {
      name: "product",
      fields: {
        name: { type: "string", translatable: true },
      },
    };
    const errors = validateTranslatableSchema(schema);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("defaultLocale");
  });

  test("returns multiple errors", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        name: { type: "string", translatable: true },
        count: { type: "number", translatable: true },
        active: { type: "boolean", translatable: true },
      },
    };
    const errors = validateTranslatableSchema(schema);
    // 2 invalid field types + 1 missing defaultLocale = 3 errors
    expect(errors.length).toBe(3);
  });

  test("allows enum field to be translatable", () => {
    const schema: SchemaDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        status: {
          type: "enum",
          translatable: true,
          options: [{ value: "active" }, { value: "inactive" }],
        },
      },
    };
    expect(validateTranslatableSchema(schema)).toEqual([]);
  });
});
