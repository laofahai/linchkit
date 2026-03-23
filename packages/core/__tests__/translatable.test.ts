import { describe, expect, test } from "bun:test";
import {
  getTranslatableFields,
  normalizeTranslatableValue,
  resolveTranslatableValue,
} from "../src/engine/translatable";
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
