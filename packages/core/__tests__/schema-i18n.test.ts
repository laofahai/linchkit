import { describe, expect, it } from "bun:test";
import { defineSchema } from "../src";

describe("Schema i18n type definitions", () => {
  it("should allow translatable flag on fields", () => {
    const schema = defineSchema({
      name: "product",
      fields: {
        name: { type: "string", required: true, translatable: true },
        sku: { type: "string", required: true },
        description: { type: "text", translatable: true },
        price: { type: "number" },
      },
    });

    expect(schema.fields.name.translatable).toBe(true);
    expect(schema.fields.sku.translatable).toBeUndefined();
    expect(schema.fields.description.translatable).toBe(true);
    expect(schema.fields.price.translatable).toBeUndefined();
  });

  it("should allow i18n config on schema", () => {
    const schema = defineSchema({
      name: "product",
      fields: {
        name: { type: "string", translatable: true },
      },
      i18n: {
        defaultLocale: "en",
        supportedLocales: ["en", "zh-CN", "ja"],
      },
    });

    expect(schema.i18n?.defaultLocale).toBe("en");
    expect(schema.i18n?.supportedLocales).toEqual(["en", "zh-CN", "ja"]);
  });

  it("should keep i18n config optional", () => {
    const schema = defineSchema({
      name: "simple",
      fields: {
        code: { type: "string" },
      },
    });

    expect(schema.i18n).toBeUndefined();
  });

  it("should allow partial i18n config", () => {
    const schema = defineSchema({
      name: "product",
      fields: {
        name: { type: "string", translatable: true },
      },
      i18n: {
        defaultLocale: "zh-CN",
      },
    });

    expect(schema.i18n?.defaultLocale).toBe("zh-CN");
    expect(schema.i18n?.supportedLocales).toBeUndefined();
  });

  it("should work with defineSchema passthrough for all properties", () => {
    const schema = defineSchema({
      name: "catalog",
      label: "Product Catalog",
      fields: {
        title: { type: "string", translatable: true, required: true },
        slug: { type: "string", required: true },
        body: { type: "text", translatable: true },
      },
      i18n: {
        defaultLocale: "en",
        supportedLocales: ["en", "zh-CN"],
      },
      exposure: { graphql: true },
    });

    // Verify i18n coexists with other schema properties
    expect(schema.name).toBe("catalog");
    expect(schema.label).toBe("Product Catalog");
    expect(schema.i18n?.defaultLocale).toBe("en");
    expect(schema.exposure?.graphql).toBe(true);
    expect(schema.fields.title.translatable).toBe(true);
    expect(schema.fields.slug.translatable).toBeUndefined();
  });
});
