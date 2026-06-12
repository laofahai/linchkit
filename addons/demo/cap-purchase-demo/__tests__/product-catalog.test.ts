/**
 * Product catalog tests — entity definition, registration, relation wiring,
 * validation constraints, and seed-data integrity.
 *
 * The product entity exists so purchase items can reference a catalog
 * product directly (用户需求: 商品管理 + 采购明细直接选择, 支持箱规/分类/规格/条码).
 *
 * Honest scope:
 * - Registration goes through the REAL EntityRegistry / RelationRegistry
 *   (same classes the runtime uses) — not bespoke mocks.
 * - Field constraints are exercised through the REAL generateZodSchema
 *   pipeline the Action Engine uses for input validation.
 * - Seed data is verified against the entity's own constraints, including
 *   EAN-13 check digits computed independently in this test.
 */

import { describe, expect, test } from "bun:test";
import { generateZodSchema } from "@linchkit/core";
import { createRelationRegistry, EntityRegistry, InMemoryStore } from "@linchkit/core/server";
import { capPurchaseDemo } from "../src/capability";
import { productEntity } from "../src/entities/product";
import { itemToProduct, requestToDepartment, requestToItems } from "../src/relations";
import { productSeedData } from "../src/seed";
import { productFormView } from "../src/views/product-form";
import { productListView } from "../src/views/product-list";
import { purchaseItemFormView } from "../src/views/purchase-item-form";

// ── Helpers ─────────────────────────────────────────────

/** Compute the EAN-13 check digit for the first 12 digits. */
function ean13CheckDigit(barcode: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(barcode[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

function enumValues(fieldName: string): string[] {
  const field = productEntity.fields[fieldName];
  if (field?.type !== "enum") throw new Error(`${fieldName} is not an enum field`);
  return field.options.map((o) => o.value);
}

const validProduct = {
  name: "中性笔（黑色 0.5mm）",
  category: "stationery",
  specification: "0.5mm 子弹头",
  barcode: "6901234560015",
  case_pack_quantity: 144,
  unit: "支",
  unit_price: 2.5,
  status: "active",
};

// ══════════════════════════════════════════════════════════
// Part 1: Entity definition + capability registration
// ══════════════════════════════════════════════════════════

describe("Product entity — definition and registration", () => {
  test("registers cleanly in the real EntityRegistry", () => {
    const registry = new EntityRegistry();
    registry.register(productEntity);
    expect(registry.get("product")).toBe(productEntity);
  });

  test("is registered in the capability alongside the other entities", () => {
    expect(capPurchaseDemo.entities).toContain(productEntity);
    const names = (capPurchaseDemo.entities ?? []).map((e) => e.name);
    expect(names).toEqual(["purchase_request", "department", "purchase_item", "product"]);
  });

  test("declares the required catalog fields (箱规/分类/规格/条码)", () => {
    const fields = productEntity.fields;
    expect(fields.name?.required).toBe(true);
    expect(fields.category?.type).toBe("enum");
    expect(fields.specification?.type).toBe("text");
    expect(fields.barcode?.unique).toBe(true);
    expect(fields.case_pack_quantity?.min).toBe(1);
    expect(fields.unit?.type).toBe("string");
    expect(fields.unit_price?.min).toBe(0);
    expect(enumValues("status")).toEqual(["active", "inactive"]);
  });

  test("never declares system fields (server-managed)", () => {
    const systemFields = ["id", "tenant_id", "created_at", "updated_at", "_version"];
    for (const name of systemFields) {
      expect(productEntity.fields[name]).toBeUndefined();
    }
  });

  test("views are registered: product list + form, purchase_item form", () => {
    expect(capPurchaseDemo.views).toContain(productListView);
    expect(capPurchaseDemo.views).toContain(productFormView);
    expect(capPurchaseDemo.views).toContain(purchaseItemFormView);
    expect(productListView.entity).toBe("product");
    expect(productFormView.entity).toBe("product");
  });

  test("seed data is wired under the entity name", () => {
    expect(capPurchaseDemo.seed?.product).toBe(productSeedData);
  });
});

// ══════════════════════════════════════════════════════════
// Part 2: purchase_item → product relation
// ══════════════════════════════════════════════════════════

describe("item_to_product relation — purchase items select a product", () => {
  test("registers in the real RelationRegistry with the other relations", () => {
    const registry = createRelationRegistry();
    for (const rel of [requestToDepartment, requestToItems, itemToProduct]) {
      registry.register(rel);
    }
    const outgoing = registry.outgoingRelations("purchase_item");
    expect(outgoing).toContain(itemToProduct);
  });

  test("is many_to_one with semantic name 'product' (FK column product_id)", () => {
    // The `fromName` is what the UI resolves to a relation selector widget
    // and translates to the `product_id` FK column on submit — the same
    // mechanism as purchase_request.department.
    expect(itemToProduct.cardinality).toBe("many_to_one");
    expect(itemToProduct.from).toBe("purchase_item");
    expect(itemToProduct.to).toBe("product");
    expect(itemToProduct.fromName).toBe("product");

    const registry = createRelationRegistry();
    registry.register(itemToProduct);
    const info = registry.relationByName("purchase_item", "product");
    expect(info?.relation).toBe(itemToProduct);
    expect(info?.direction).toBe("outgoing");
  });

  test("is registered in the capability", () => {
    expect(capPurchaseDemo.relations).toContain(itemToProduct);
  });

  test("purchase_item form view exposes the 'product' relation field", () => {
    // The fallback auto-form only renders scalar entity fields — the explicit
    // view field is what makes the product selector appear on the item form.
    const fieldNames = purchaseItemFormView.fields.map((f) => f.field);
    expect(fieldNames).toContain("product");
  });
});

// ══════════════════════════════════════════════════════════
// Part 3: Field constraints via the real Zod validation pipeline
// ══════════════════════════════════════════════════════════

describe("Product validation — generateZodSchema constraints", () => {
  const zod = generateZodSchema(productEntity);

  test("accepts a fully valid product", () => {
    expect(zod.safeParse(validProduct).success).toBe(true);
  });

  test("rejects a product without a name", () => {
    const { name: _name, ...rest } = validProduct;
    expect(zod.safeParse(rest).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    expect(zod.safeParse({ ...validProduct, category: "furniture" }).success).toBe(false);
  });

  test("rejects case_pack_quantity below 1 (箱规 must be at least 1)", () => {
    expect(zod.safeParse({ ...validProduct, case_pack_quantity: 0 }).success).toBe(false);
    expect(zod.safeParse({ ...validProduct, case_pack_quantity: -5 }).success).toBe(false);
    expect(zod.safeParse({ ...validProduct, case_pack_quantity: 1 }).success).toBe(true);
  });

  test("rejects a fractional case_pack_quantity (a case pack is a whole count)", () => {
    expect(zod.safeParse({ ...validProduct, case_pack_quantity: 1.5 }).success).toBe(false);
    expect(zod.safeParse({ ...validProduct, case_pack_quantity: 12 }).success).toBe(true);
  });

  test("rejects a negative unit_price", () => {
    expect(zod.safeParse({ ...validProduct, unit_price: -0.01 }).success).toBe(false);
    expect(zod.safeParse({ ...validProduct, unit_price: 0 }).success).toBe(true);
  });

  test("rejects non-numeric or wrong-length barcodes", () => {
    expect(zod.safeParse({ ...validProduct, barcode: "ABC123" }).success).toBe(false);
    expect(zod.safeParse({ ...validProduct, barcode: "123" }).success).toBe(false);
    // EAN-8 is acceptable
    expect(zod.safeParse({ ...validProduct, barcode: "12345678" }).success).toBe(true);
  });

  test('barcode is optional — a blank input normalizes to absent, not stored as ""', () => {
    const { barcode: _barcode, ...rest } = validProduct;
    expect(zod.safeParse(rest).success).toBe(true);
    // A blank UI input submits "". The schema generator normalizes it to absent
    // (undefined) rather than storing "" — "" is a concrete value that would
    // collide on the barcode unique index, whereas an omitted/NULL barcode is
    // unique-exempt in PostgreSQL.
    const blank = zod.safeParse({ ...validProduct, barcode: "" });
    expect(blank.success).toBe(true);
    expect(blank.data?.barcode).toBeUndefined();
  });

  test("rejects an unknown status", () => {
    expect(zod.safeParse({ ...validProduct, status: "archived" }).success).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// Part 4: Seed data integrity
// ══════════════════════════════════════════════════════════

describe("Product seed data — office-supply catalog", () => {
  const zod = generateZodSchema(productEntity);

  test("contains at least 6 products with unique ids", () => {
    expect(productSeedData.length).toBeGreaterThanOrEqual(6);
    const ids = productSeedData.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every seed product passes the entity's own validation", () => {
    for (const { id: _id, ...product } of productSeedData) {
      const result = zod.safeParse(product);
      expect(result.success).toBe(true);
    }
  });

  test("barcodes are unique, 13 digits, with valid EAN-13 check digits", () => {
    const barcodes = productSeedData.map((p) => p.barcode);
    expect(new Set(barcodes).size).toBe(barcodes.length);
    for (const barcode of barcodes) {
      expect(barcode).toMatch(/^\d{13}$/);
      expect(Number(barcode[12])).toBe(ean13CheckDigit(barcode));
    }
  });

  test("categories stay within the declared enum", () => {
    const allowed = new Set(enumValues("category"));
    for (const product of productSeedData) {
      expect(allowed.has(product.category)).toBe(true);
    }
  });

  test("箱规 and prices are realistic (case pack >= 1, price > 0)", () => {
    for (const product of productSeedData) {
      expect(product.case_pack_quantity).toBeGreaterThanOrEqual(1);
      expect(product.unit_price).toBeGreaterThan(0);
      expect(product.unit.length).toBeGreaterThan(0);
    }
  });
});

// ══════════════════════════════════════════════════════════
// Part 5: Store round-trip with a product-linked purchase item
// ══════════════════════════════════════════════════════════

describe("Product CRUD round-trip — InMemoryStore + zod gate", () => {
  test("create → get → update → delete, validated at each write", async () => {
    const store = new InMemoryStore();
    const zod = generateZodSchema(productEntity);

    // Create (validate input the way the action pipeline would)
    const input = zod.parse(validProduct);
    const created = await store.create("product", input);
    expect(created.id).toBeDefined();
    expect(created.name).toBe(validProduct.name);

    // Read
    const fetched = await store.get("product", String(created.id));
    expect(fetched?.barcode).toBe(validProduct.barcode);

    // Update (partial — re-validated through the same schema)
    const patch = zod.partial().parse({ unit_price: 2.8, status: "inactive" });
    const updated = await store.update("product", String(created.id), patch);
    expect(updated.unit_price).toBe(2.8);
    expect(updated.status).toBe("inactive");

    // A purchase item references BOTH its parent request (NOT-NULL FK column
    // purchase_request_id from the request_to_items cascade relation) and the
    // catalog product (product_id FK from item_to_product). InMemoryStore does
    // not enforce FKs, but we wire the request_id the way PG requires so the
    // round-trip mirrors production rather than passing on a half-built row.
    const request = await store.create("purchase_request", {
      title: "Stationery restock",
      amount: 28,
      requester_email: "buyer@example.com",
    });
    const item = await store.create("purchase_item", {
      name: validProduct.name,
      quantity: 10,
      unit_price: 2.8,
      purchase_request_id: request.id,
      product_id: created.id,
    });
    expect(item.purchase_request_id).toBe(request.id);
    expect(item.product_id).toBe(created.id);

    // Delete order honors the item_to_product FK semantics (RESTRICT — the
    // relation declares no cascade): a product still referenced by an item
    // cannot be hard-deleted in PG, so production deactivates via
    // status=inactive instead. Here we remove the referencing item first, then
    // the product (soft delete in InMemoryStore — subsequent reads throw).
    await store.delete("purchase_item", String(item.id));
    await store.delete("product", String(created.id));
    await expect(store.get("product", String(created.id))).rejects.toThrow("Record not found");
  });
});
