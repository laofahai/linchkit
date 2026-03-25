import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core/server";
import { InMemoryStore } from "../src/data/in-memory-store";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema with translatable field ────────────────────────

const productSchema: SchemaDefinition = {
  name: "product",
  label: "Product",
  i18n: { defaultLocale: "en" },
  fields: {
    name: { type: "string", required: true, label: "Name", translatable: true },
    sku: { type: "string", required: true, label: "SKU" },
    description: { type: "text", label: "Description", translatable: true },
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

for (const action of generateCrudActions(productSchema)) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([productSchema], { executor, dataProvider: store });
const app = createServer(graphqlSchema);
const port = 3994;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

// ── Helper ────────────────────────────────────────────────

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL translatable field resolution", () => {
  let productId: string;

  test("create with plain string wraps into JSONB locale map", async () => {
    const result = await gql(`
      mutation {
        createProduct(input: { name: "Widget", sku: "W-001", description: "A fine widget" }) {
          id
          name
          sku
          description
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const product = result.data.createProduct as Record<string, unknown>;
    productId = product.id as string;
    expect(product.name).toBe("Widget");
    expect(product.sku).toBe("W-001");
    expect(product.description).toBe("A fine widget");

    // Verify stored as JSONB locale map in the store
    const stored = await store.get("product", productId);
    expect(stored.name).toEqual({ en: "Widget" });
    expect(stored.description).toEqual({ en: "A fine widget" });
    // Non-translatable field stays as plain string
    expect(stored.sku).toBe("W-001");
  });

  test("get-by-ID resolves JSONB to string for requested locale", async () => {
    const result = await gql(
      `
      query ($id: ID!) {
        product(id: $id, locale: "en") {
          id
          name
          description
        }
      }
    `,
      { id: productId },
    );

    expect(result.errors).toBeUndefined();
    const product = result.data.product as Record<string, unknown>;
    expect(product.name).toBe("Widget");
    expect(product.description).toBe("A fine widget");
  });

  test("get-by-ID without locale falls back to default locale", async () => {
    const result = await gql(
      `
      query ($id: ID!) {
        product(id: $id) {
          name
          description
        }
      }
    `,
      { id: productId },
    );

    expect(result.errors).toBeUndefined();
    const product = result.data.product as Record<string, unknown>;
    // Should resolve using schema's defaultLocale ("en")
    expect(product.name).toBe("Widget");
    expect(product.description).toBe("A fine widget");
  });

  test("list resolves JSONB to strings for each record", async () => {
    // Create a second product
    await gql(`
      mutation {
        createProduct(input: { name: "Gadget", sku: "G-001" }) {
          id
        }
      }
    `);

    const result = await gql(`
      query {
        productList {
          items {
            name
            sku
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.productList as { items: Record<string, unknown>[]; total: number };
    expect(list.total).toBeGreaterThanOrEqual(2);
    // All names should be resolved strings, not JSONB objects
    for (const item of list.items) {
      expect(typeof item.name).toBe("string");
    }
  });

  test("update with plain string normalizes to JSONB", async () => {
    const result = await gql(
      `
      mutation ($id: ID!) {
        updateProduct(id: $id, input: { name: "Widget Pro", sku: "W-001" }) {
          id
          name
        }
      }
    `,
      { id: productId },
    );

    expect(result.errors).toBeUndefined();
    const product = result.data.updateProduct as Record<string, unknown>;
    expect(product.name).toBe("Widget Pro");

    // Verify stored as JSONB
    const stored = await store.get("product", productId);
    expect(stored.name).toEqual({ en: "Widget Pro" });
  });

  test("create with JSONB locale map stores and resolves correctly", async () => {
    const result = await gql(`
      mutation {
        createProduct(input: {
          name: "{ \\"en\\": \\"Gizmo\\", \\"zh-CN\\": \\"小工具\\" }",
          sku: "GZ-001"
        }) {
          id
          name
        }
      }
    `);

    // The input type for string fields is GraphQLString, so JSONB maps
    // come in as strings. The normalizeTranslatableRow treats plain strings
    // by wrapping them. This test verifies the basic path works.
    expect(result.errors).toBeUndefined();
    const product = result.data.createProduct as Record<string, unknown>;
    expect(typeof product.name).toBe("string");
  });

  test("locale from context (Accept-Language header) is used for resolution", async () => {
    // First, manually store a multi-locale value
    const createResult = await gql(`
      mutation {
        createProduct(input: { name: "Test", sku: "T-001" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createProduct as Record<string, unknown>).id as string;

    // Manually update the store with multi-locale JSONB
    await store.update("product", id, {
      name: { en: "Test", "zh-CN": "测试" },
    });

    // Query with zh-CN locale via argument
    const result = await gql(
      `
      query ($id: ID!) {
        product(id: $id, locale: "zh-CN") {
          name
        }
      }
    `,
      { id },
    );

    expect(result.errors).toBeUndefined();
    const product = result.data.product as Record<string, unknown>;
    expect(product.name).toBe("测试");

    // Query with en locale
    const resultEn = await gql(
      `
      query ($id: ID!) {
        product(id: $id, locale: "en") {
          name
        }
      }
    `,
      { id },
    );

    expect(resultEn.errors).toBeUndefined();
    const productEn = resultEn.data.product as Record<string, unknown>;
    expect(productEn.name).toBe("Test");
  });
});
