/**
 * Tests for InMemoryStore search and filter with translatable fields
 *
 * Verifies that full-text search and filter conditions correctly handle
 * JSONB locale-map values stored in translatable fields.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryStore } from "../src/persistence/in-memory-store";
import type { EntityDefinition } from "../src/types/entity";

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  i18n: { defaultLocale: "en", supportedLocales: ["en", "zh-CN", "ja"] },
  fields: {
    name: { type: "string", required: true, translatable: true },
    description: { type: "text", translatable: true },
    sku: { type: "string", required: true },
    price: { type: "number" },
  },
};

describe("InMemoryStore translatable search", () => {
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    store.registerEntity(productSchema);

    await store.create("product", {
      id: "p1",
      name: { en: "Widget", "zh-CN": "小工具", ja: "ウィジェット" },
      description: { en: "A useful widget", "zh-CN": "一个有用的小工具" },
      sku: "W-001",
      price: 9.99,
    });
    await store.create("product", {
      id: "p2",
      name: { en: "Gadget", "zh-CN": "小装置" },
      description: { en: "A cool gadget", "zh-CN": "一个酷炫的小装置" },
      sku: "G-001",
      price: 19.99,
    });
    await store.create("product", {
      id: "p3",
      name: { en: "Sprocket", "zh-CN": "链轮" },
      description: { en: "Industrial sprocket" },
      sku: "S-001",
      price: 5.99,
    });
  });

  test("search finds records by English locale value", async () => {
    const results = await store.query("product", { search: "widget" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("search finds records by Chinese locale value", async () => {
    const results = await store.query("product", { search: "小工具" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("search finds records by Japanese locale value", async () => {
    const results = await store.query("product", { search: "ウィジェット" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("search matches across multiple translatable fields", async () => {
    // "cool" appears in description of p2
    const results = await store.query("product", { search: "cool" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p2");
  });

  test("search is case-insensitive for translatable values", async () => {
    const results = await store.query("product", { search: "WIDGET" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("search still matches non-translatable string fields", async () => {
    const results = await store.query("product", { search: "G-001" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p2");
  });

  test("search with partial match in Chinese", async () => {
    // "小" appears in p1 name "小工具" and p2 name "小装置"
    const results = await store.query("product", { search: "小" });
    // p1: name has "小工具", description has "小工具"
    // p2: name has "小装置", description has "小装置"
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  test("search returns empty for unmatched keyword", async () => {
    const results = await store.query("product", { search: "nonexistent" });
    expect(results).toHaveLength(0);
  });
});

describe("InMemoryStore translatable filter", () => {
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    store.registerEntity(productSchema);

    await store.create("product", {
      id: "p1",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-001",
      price: 9.99,
    });
    await store.create("product", {
      id: "p2",
      name: { en: "Gadget", "zh-CN": "小装置" },
      sku: "G-001",
      price: 19.99,
    });
    await store.create("product", {
      id: "p3",
      name: { en: "Widget Pro", "zh-CN": "专业小工具" },
      sku: "WP-001",
      price: 29.99,
    });
  });

  test("filter matches translatable field by English value", async () => {
    const results = await store.query("product", { name: "Widget" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("filter matches translatable field by Chinese value", async () => {
    const results = await store.query("product", { name: "小工具" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("filter does not partial match (exact locale value required)", async () => {
    const results = await store.query("product", { name: "Wid" });
    expect(results).toHaveLength(0);
  });

  test("filter on non-translatable field still works", async () => {
    const results = await store.query("product", { sku: "G-001" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p2");
  });

  test("combined filter: translatable + non-translatable fields", async () => {
    const results = await store.query("product", { name: "Widget", sku: "W-001" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("p1");
  });

  test("combined filter: translatable field mismatch returns empty", async () => {
    const results = await store.query("product", { name: "Widget", sku: "G-001" });
    expect(results).toHaveLength(0);
  });

  test("filter with locale resolution still returns unresolved data without locale option", async () => {
    const results = await store.query("product", { name: "Widget" });
    expect(results).toHaveLength(1);
    // Without locale option, name is raw JSONB
    expect(results[0]?.name).toEqual({ en: "Widget", "zh-CN": "小工具" });
  });

  test("filter with locale option resolves translatable fields in output", async () => {
    const results = await store.query("product", { name: "Widget" }, { locale: "zh-CN" });
    expect(results).toHaveLength(1);
    // With locale option, name is resolved
    expect(results[0]?.name).toBe("小工具");
  });
});

describe("InMemoryStore translatable count", () => {
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    store.registerEntity(productSchema);

    await store.create("product", {
      id: "p1",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-001",
    });
    await store.create("product", {
      id: "p2",
      name: { en: "Gadget", "zh-CN": "小装置" },
      sku: "G-001",
    });
  });

  test("count with search matches translatable values", async () => {
    const total = await store.count("product", { search: "Widget" });
    expect(total).toBe(1);
  });

  test("count with search matches Chinese translatable values", async () => {
    const total = await store.count("product", { search: "小" });
    expect(total).toBe(2);
  });

  test("count with search returns 0 for no match", async () => {
    const total = await store.count("product", { search: "xyz" });
    expect(total).toBe(0);
  });
});
