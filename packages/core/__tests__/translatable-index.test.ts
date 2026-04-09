/**
 * Tests for translatable field index DDL generation helpers
 */

import { describe, expect, test } from "bun:test";
import {
  generateExpressionIndex,
  generateGinIndex,
  generateTranslatableIndexes,
} from "../src/entity/translatable-index";
import type { EntityDefinition } from "../src/types/entity";

describe("generateExpressionIndex", () => {
  test("generates correct DDL for simple locale", () => {
    const result = generateExpressionIndex("product", "name", "en");
    expect(result).toBe("CREATE INDEX idx_product_name_en ON product ((name->>'en'))");
  });

  test("generates correct DDL for hyphenated locale (zh-CN)", () => {
    const result = generateExpressionIndex("product", "name", "zh-CN");
    expect(result).toBe("CREATE INDEX idx_product_name_zh_CN ON product ((name->>'zh-CN'))");
  });

  test("generates correct DDL for Japanese locale", () => {
    const result = generateExpressionIndex("category", "label", "ja");
    expect(result).toBe("CREATE INDEX idx_category_label_ja ON category ((label->>'ja'))");
  });

  test("sanitizes locale with dots (e.g. sr-Latn.RS)", () => {
    const result = generateExpressionIndex("article", "title", "sr-Latn.RS");
    expect(result).toBe(
      "CREATE INDEX idx_article_title_sr_Latn_RS ON article ((title->>'sr-Latn.RS'))",
    );
  });

  test("works with description field", () => {
    const result = generateExpressionIndex("product", "description", "en");
    expect(result).toBe(
      "CREATE INDEX idx_product_description_en ON product ((description->>'en'))",
    );
  });
});

describe("generateGinIndex", () => {
  test("generates correct GIN index DDL", () => {
    const result = generateGinIndex("product", "name");
    expect(result).toBe("CREATE INDEX idx_product_name_gin ON product USING GIN (name)");
  });

  test("generates correct GIN index for description field", () => {
    const result = generateGinIndex("product", "description");
    expect(result).toBe(
      "CREATE INDEX idx_product_description_gin ON product USING GIN (description)",
    );
  });
});

describe("generateTranslatableIndexes", () => {
  test("returns empty array for entity without translatable fields", () => {
    const entity: EntityDefinition = {
      name: "counter",
      fields: {
        label: { type: "string" },
        count: { type: "number" },
      },
    };
    const result = generateTranslatableIndexes(entity, "counter");
    expect(result).toEqual([]);
  });

  test("generates indexes using supportedLocales", () => {
    const entity: EntityDefinition = {
      name: "product",
      i18n: {
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN", "en", "ja"],
      },
      fields: {
        name: { type: "string", translatable: true },
        sku: { type: "string" },
      },
    };
    const result = generateTranslatableIndexes(entity, "product");
    expect(result).toEqual([
      "CREATE INDEX idx_product_name_zh_CN ON product ((name->>'zh-CN'))",
      "CREATE INDEX idx_product_name_en ON product ((name->>'en'))",
      "CREATE INDEX idx_product_name_ja ON product ((name->>'ja'))",
      "CREATE INDEX idx_product_name_gin ON product USING GIN (name)",
    ]);
  });

  test("falls back to defaultLocale when supportedLocales is not set", () => {
    const entity: EntityDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        name: { type: "string", translatable: true },
      },
    };
    const result = generateTranslatableIndexes(entity, "product");
    expect(result).toEqual([
      "CREATE INDEX idx_product_name_en ON product ((name->>'en'))",
      "CREATE INDEX idx_product_name_gin ON product USING GIN (name)",
    ]);
  });

  test("generates indexes for multiple translatable fields", () => {
    const entity: EntityDefinition = {
      name: "product",
      i18n: {
        defaultLocale: "en",
        supportedLocales: ["en", "zh-CN"],
      },
      fields: {
        name: { type: "string", translatable: true },
        description: { type: "text", translatable: true },
        sku: { type: "string" },
        price: { type: "number" },
      },
    };
    const result = generateTranslatableIndexes(entity, "product");
    // name: 2 expression + 1 GIN, description: 2 expression + 1 GIN = 6 total
    expect(result).toHaveLength(6);
    expect(result).toContain("CREATE INDEX idx_product_name_en ON product ((name->>'en'))");
    expect(result).toContain("CREATE INDEX idx_product_name_zh_CN ON product ((name->>'zh-CN'))");
    expect(result).toContain("CREATE INDEX idx_product_name_gin ON product USING GIN (name)");
    expect(result).toContain(
      "CREATE INDEX idx_product_description_en ON product ((description->>'en'))",
    );
    expect(result).toContain(
      "CREATE INDEX idx_product_description_zh_CN ON product ((description->>'zh-CN'))",
    );
    expect(result).toContain(
      "CREATE INDEX idx_product_description_gin ON product USING GIN (description)",
    );
  });

  test("generates only GIN index when no locales configured", () => {
    const entity: EntityDefinition = {
      name: "product",
      fields: {
        name: { type: "string", translatable: true },
      },
    };
    const result = generateTranslatableIndexes(entity, "product");
    // No supportedLocales, no defaultLocale -> only GIN index
    expect(result).toEqual(["CREATE INDEX idx_product_name_gin ON product USING GIN (name)"]);
  });

  test("uses table name different from entity name", () => {
    const entity: EntityDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        name: { type: "string", translatable: true },
      },
    };
    const result = generateTranslatableIndexes(entity, "app_product");
    expect(result).toEqual([
      "CREATE INDEX idx_app_product_name_en ON app_product ((name->>'en'))",
      "CREATE INDEX idx_app_product_name_gin ON app_product USING GIN (name)",
    ]);
  });
});
