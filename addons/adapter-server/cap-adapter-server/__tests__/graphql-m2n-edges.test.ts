/**
 * Tests for M:N link edge type property exposure in GraphQL.
 *
 * Validates that many_to_many links with `properties` generate edge types
 * that include both the related record and junction table properties,
 * while M:N links without properties continue to return plain arrays.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition, RelationDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { clearEdgeTypeCache } from "../src/graphql/relation-resolvers";
import { createServer } from "../src/server";

// ── Schema definitions ────────────────────────────────────

const salesOrderSchema: EntityDefinition = {
  name: "sales_order",
  label: "Sales Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    total: { type: "number", label: "Total" },
  },
};

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    sku: { type: "string", label: "SKU" },
    price: { type: "number", label: "Price" },
  },
};

const tagSchema: EntityDefinition = {
  name: "tag",
  label: "Tag",
  fields: {
    label: { type: "string", required: true, label: "Label" },
  },
};

const articleSchema: EntityDefinition = {
  name: "article",
  label: "Article",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

// ── Link definitions ──────────────────────────────────────

/** M:N with properties — should generate edge types */
const orderToProducts: RelationDefinition = {
  name: "order_to_products",
  from: "sales_order",
  to: "product",
  cardinality: "many_to_many",
  properties: {
    quantity: { type: "number", required: true, label: "Quantity" },
    unit_price: { type: "number", required: true, label: "Unit Price" },
    discount: { type: "number", label: "Discount" },
    note: { type: "string", label: "Note" },
  },
  label: {
    from: "Order products",
    to: "Product orders",
  },
};

/** M:N without properties — should return plain arrays */
const articleToTags: RelationDefinition = {
  name: "article_to_tags",
  from: "article",
  to: "tag",
  cardinality: "many_to_many",
  label: {
    from: "Tags",
    to: "Articles",
  },
};

// ── Setup ────────────────────────────────────────────────

const PORT = 32160;
const GQL_URL = `http://localhost:${PORT}/graphql`;

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  clearEdgeTypeCache();
  store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  const schemas = [salesOrderSchema, productSchema, tagSchema, articleSchema];
  for (const schema of schemas) {
    for (const action of generateCrudActions(schema)) {
      executor.registry.register(action);
    }
  }

  const schemaMap = new Map<string, EntityDefinition>();
  for (const s of schemas) schemaMap.set(s.name, s);

  const graphqlSchema = buildGraphQLSchema(schemas, {
    executor,
    dataProvider: store,
    relations: [orderToProducts, articleToTags],
  });

  app = createServer(graphqlSchema, {
    dataProvider: store,
    schemaMap,
  });
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("M:N link with properties (edge types)", () => {
  test("1. Edge type returns related record and junction properties", async () => {
    // Seed data
    await store.create("sales_order", { id: "so_1", title: "Order #1", total: 500 });
    await store.create("product", { id: "prod_1", name: "Widget A", sku: "WA-001", price: 25 });
    await store.create("product", { id: "prod_2", name: "Widget B", sku: "WB-002", price: 50 });

    // Seed junction table rows with properties
    await store.create("_link_order_to_products", {
      id: "jn_1",
      sales_order_id: "so_1",
      product_id: "prod_1",
      quantity: 10,
      unit_price: 25,
      discount: 5,
      note: "Bulk order",
    });
    await store.create("_link_order_to_products", {
      id: "jn_2",
      sales_order_id: "so_1",
      product_id: "prod_2",
      quantity: 5,
      unit_price: 50,
      discount: 0,
      note: null,
    });

    // Query: salesOrder should have productEdges field
    const result = await gql(`
      query {
        salesOrder(id: "so_1") {
          id
          title
          productEdges {
            product {
              id
              name
              sku
              price
            }
            quantity
            unitPrice
            discount
            note
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.salesOrder as Record<string, unknown>;
    expect(order.title).toBe("Order #1");

    const edges = order.productEdges as Array<Record<string, unknown>>;
    expect(edges).toBeDefined();
    expect(edges.length).toBe(2);

    // Find the Widget A edge
    const edgeA = edges.find((e) => (e.product as Record<string, unknown>).name === "Widget A");
    expect(edgeA).toBeDefined();
    expect(edgeA?.quantity).toBe(10);
    expect(edgeA?.unitPrice).toBe(25);
    expect(edgeA?.discount).toBe(5);
    expect(edgeA?.note).toBe("Bulk order");

    // Verify the product record
    const prodA = edgeA?.product as Record<string, unknown>;
    expect(prodA.id).toBe("prod_1");
    expect(prodA.sku).toBe("WA-001");

    // Find the Widget B edge
    const edgeB = edges.find((e) => (e.product as Record<string, unknown>).name === "Widget B");
    expect(edgeB).toBeDefined();
    expect(edgeB?.quantity).toBe(5);
    expect(edgeB?.unitPrice).toBe(50);
    expect(edgeB?.discount).toBe(0);
  });

  test("2. Reverse direction: product has salesOrderEdges", async () => {
    await store.create("sales_order", { id: "so_2", title: "Order #2", total: 100 });
    await store.create("product", { id: "prod_3", name: "Gadget X", sku: "GX-001", price: 100 });

    await store.create("_link_order_to_products", {
      id: "jn_3",
      sales_order_id: "so_2",
      product_id: "prod_3",
      quantity: 1,
      unit_price: 100,
      discount: 10,
      note: "VIP discount",
    });

    const result = await gql(`
      query {
        product(id: "prod_3") {
          id
          name
          salesOrderEdges {
            salesOrder {
              id
              title
            }
            quantity
            unitPrice
            discount
            note
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const product = result.data.product as Record<string, unknown>;
    expect(product.name).toBe("Gadget X");

    const edges = product.salesOrderEdges as Array<Record<string, unknown>>;
    expect(edges).toBeDefined();
    expect(edges.length).toBe(1);
    expect(edges[0].quantity).toBe(1);
    expect(edges[0].unitPrice).toBe(100);
    expect(edges[0].discount).toBe(10);
    expect(edges[0].note).toBe("VIP discount");

    const order = edges[0].salesOrder as Record<string, unknown>;
    expect(order.id).toBe("so_2");
    expect(order.title).toBe("Order #2");
  });

  test("3. Empty edges when no junction rows exist", async () => {
    await store.create("sales_order", { id: "so_empty", title: "Empty Order", total: 0 });

    const result = await gql(`
      query {
        salesOrder(id: "so_empty") {
          id
          productEdges {
            product { id name }
            quantity
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.salesOrder as Record<string, unknown>;
    const edges = order.productEdges as Array<Record<string, unknown>>;
    expect(edges).toBeDefined();
    expect(edges.length).toBe(0);
  });
});

describe("M:N link without properties (plain arrays)", () => {
  test("4. Plain M:N returns flat array of related records", async () => {
    await store.create("article", { id: "art_1", title: "My Article" });
    await store.create("tag", { id: "tag_1", label: "TypeScript" });
    await store.create("tag", { id: "tag_2", label: "GraphQL" });

    // Seed junction table (no extra properties)
    await store.create("_link_article_to_tags", {
      id: "jn_t1",
      article_id: "art_1",
      tag_id: "tag_1",
    });
    await store.create("_link_article_to_tags", {
      id: "jn_t2",
      article_id: "art_1",
      tag_id: "tag_2",
    });

    const result = await gql(`
      query {
        article(id: "art_1") {
          id
          title
          tags {
            id
            label
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const article = result.data.article as Record<string, unknown>;
    expect(article.title).toBe("My Article");

    const tags = article.tags as Array<Record<string, unknown>>;
    expect(tags).toBeDefined();
    expect(tags.length).toBe(2);

    const labels = tags.map((t) => t.label).sort();
    expect(labels).toEqual(["GraphQL", "TypeScript"]);
  });

  test("5. Reverse: tag has articles (plain array)", async () => {
    await store.create("article", { id: "art_2", title: "Article Two" });
    await store.create("tag", { id: "tag_3", label: "Bun" });

    await store.create("_link_article_to_tags", {
      id: "jn_t3",
      article_id: "art_2",
      tag_id: "tag_3",
    });

    const result = await gql(`
      query {
        tag(id: "tag_3") {
          id
          label
          articles {
            id
            title
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const tag = result.data.tag as Record<string, unknown>;
    expect(tag.label).toBe("Bun");

    const articles = tag.articles as Array<Record<string, unknown>>;
    expect(articles).toBeDefined();
    expect(articles.length).toBe(1);
    expect(articles[0].title).toBe("Article Two");
  });
});

describe("Edge type field typing", () => {
  test("6. Required edge properties are non-null in response", async () => {
    await store.create("sales_order", { id: "so_typed", title: "Typed Order", total: 0 });
    await store.create("product", { id: "prod_typed", name: "Item", sku: "I-1", price: 10 });

    await store.create("_link_order_to_products", {
      id: "jn_typed",
      sales_order_id: "so_typed",
      product_id: "prod_typed",
      quantity: 3,
      unit_price: 10,
      discount: null,
      note: null,
    });

    const result = await gql(`
      query {
        salesOrder(id: "so_typed") {
          productEdges {
            product { id name }
            quantity
            unitPrice
            discount
            note
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.salesOrder as Record<string, unknown>;
    const edges = order.productEdges as Array<Record<string, unknown>>;
    expect(edges.length).toBe(1);
    expect(edges[0].quantity).toBe(3);
    expect(edges[0].unitPrice).toBe(10);
    // Optional fields can be null
    expect(edges[0].discount).toBeNull();
    expect(edges[0].note).toBeNull();
  });

  test("7. Edge with junction row pointing to non-existent record is skipped", async () => {
    await store.create("sales_order", { id: "so_orphan", title: "Orphan Order", total: 0 });

    // Junction row points to a product that doesn't exist
    await store.create("_link_order_to_products", {
      id: "jn_orphan",
      sales_order_id: "so_orphan",
      product_id: "nonexistent_product",
      quantity: 1,
      unit_price: 99,
    });

    const result = await gql(`
      query {
        salesOrder(id: "so_orphan") {
          productEdges {
            product { id name }
            quantity
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.salesOrder as Record<string, unknown>;
    const edges = order.productEdges as Array<Record<string, unknown>>;
    // Orphan junction row should be skipped (product not found)
    expect(edges.length).toBe(0);
  });
});
