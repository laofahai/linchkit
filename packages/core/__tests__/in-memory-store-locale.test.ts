/**
 * Tests for InMemoryStore translatable field locale resolution
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryStore } from "../src/persistence/in-memory-store";
import type { SchemaDefinition } from "../src/types/schema";

const productSchema: SchemaDefinition = {
  name: "product",
  label: "Product",
  i18n: { defaultLocale: "en" },
  fields: {
    name: { type: "string", required: true, translatable: true },
    sku: { type: "string", required: true },
    description: { type: "text", translatable: true },
  },
};

describe("InMemoryStore locale resolution", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
    store.registerSchema(productSchema);
  });

  test("get() returns raw JSONB when no locale provided", async () => {
    await store.create("product", {
      id: "p1",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-001",
    });
    const record = await store.get("product", "p1");
    expect(record.name).toEqual({ en: "Widget", "zh-CN": "小工具" });
  });

  test("get() resolves JSONB to string for requested locale", async () => {
    await store.create("product", {
      id: "p2",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-002",
    });
    const record = await store.get("product", "p2", { locale: "zh-CN" });
    expect(record.name).toBe("小工具");
  });

  test("get() resolves to English when locale is 'en'", async () => {
    await store.create("product", {
      id: "p3",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-003",
    });
    const record = await store.get("product", "p3", { locale: "en" });
    expect(record.name).toBe("Widget");
  });

  test("get() falls back to default locale when requested locale not available", async () => {
    await store.create("product", {
      id: "p4",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-004",
    });
    const record = await store.get("product", "p4", { locale: "ja" });
    // Falls back to defaultLocale "en"
    expect(record.name).toBe("Widget");
  });

  test("get() does not affect non-translatable fields", async () => {
    await store.create("product", {
      id: "p5",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "W-005",
    });
    const record = await store.get("product", "p5", { locale: "en" });
    expect(record.sku).toBe("W-005");
  });

  test("query() resolves JSONB to strings for all records", async () => {
    await store.create("product", {
      id: "q1",
      name: { en: "Alpha", "zh-CN": "甲" },
      sku: "A-001",
    });
    await store.create("product", {
      id: "q2",
      name: { en: "Beta", "zh-CN": "乙" },
      sku: "B-001",
    });

    const records = await store.query("product", {}, { locale: "zh-CN" });
    const q1 = records.find((r) => r.id === "q1");
    const q2 = records.find((r) => r.id === "q2");
    expect(q1?.name).toBe("甲");
    expect(q2?.name).toBe("乙");
  });

  test("query() returns raw JSONB when no locale provided", async () => {
    await store.create("product", {
      id: "r1",
      name: { en: "Gamma", "zh-CN": "丙" },
      sku: "G-001",
    });

    const records = await store.query("product", {});
    const r1 = records.find((r) => r.id === "r1");
    expect(r1?.name).toEqual({ en: "Gamma", "zh-CN": "丙" });
  });

  test("no locale resolution when schema not registered", async () => {
    const plainStore = new InMemoryStore(); // no registerSchema
    await plainStore.create("product", {
      id: "nr1",
      name: { en: "Widget", "zh-CN": "小工具" },
      sku: "NR-001",
    });
    // With locale but no schema registered — returns raw JSONB
    const record = await plainStore.get("product", "nr1", { locale: "zh-CN" });
    expect(record.name).toEqual({ en: "Widget", "zh-CN": "小工具" });
  });
});
