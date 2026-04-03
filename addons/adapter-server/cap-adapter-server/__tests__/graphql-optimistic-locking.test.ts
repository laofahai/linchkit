import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const itemSchema: SchemaDefinition = {
  name: "item",
  label: "Item",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    quantity: { type: "number", label: "Quantity" },
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

for (const action of generateCrudActions(itemSchema)) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([itemSchema], { executor, dataProvider: store });
const app = createServer(graphqlSchema);
const port = 3997;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{
    data: Record<string, unknown>;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL optimistic locking (_version)", () => {
  let recordId: string;

  test("create record → version 1", async () => {
    const result = await gql(`
      mutation {
        createItem(input: { title: "Widget", quantity: 10 }) {
          id
          title
          quantity
          _version
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const item = result.data.createItem as Record<string, unknown>;
    expect(item._version).toBe(1);
    expect(item.title).toBe("Widget");
    recordId = item.id as string;
  });

  test("update with correct _version → succeeds, version becomes 2", async () => {
    const result = await gql(
      `
      mutation UpdateItem($id: ID!, $version: Int) {
        updateItem(id: $id, input: { title: "Widget v2", quantity: 20 }, _version: $version) {
          id
          title
          quantity
          _version
        }
      }
    `,
      { id: recordId, version: 1 },
    );

    expect(result.errors).toBeUndefined();
    const item = result.data.updateItem as Record<string, unknown>;
    expect(item.title).toBe("Widget v2");
    expect(item.quantity).toBe(20);
    expect(item._version).toBe(2);
  });

  test("update with stale _version → ConflictError", async () => {
    // Record is now at version 2, but we send version 1 (stale)
    const result = await gql(
      `
      mutation UpdateItem($id: ID!, $version: Int) {
        updateItem(id: $id, input: { title: "Widget v3" }, _version: $version) {
          id
          title
          _version
        }
      }
    `,
      { id: recordId, version: 1 },
    );

    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.[0].message).toContain("Version conflict");
    expect(result.errors?.[0].extensions?.code).toBe("CONFLICT");
  });

  test("update without _version → succeeds (no locking enforced)", async () => {
    // When _version is not provided, the update should succeed without version check
    const result = await gql(
      `
      mutation UpdateItem($id: ID!) {
        updateItem(id: $id, input: { title: "Widget v3" }) {
          id
          title
          _version
        }
      }
    `,
      { id: recordId },
    );

    expect(result.errors).toBeUndefined();
    const item = result.data.updateItem as Record<string, unknown>;
    expect(item.title).toBe("Widget v3");
    // Version should still increment
    expect(item._version).toBe(3);
  });

  test("concurrent updates — second writer with stale version fails", async () => {
    // Simulate two concurrent readers who both read version 3
    const currentVersion = 3;

    // Writer A updates successfully
    const resultA = await gql(
      `
      mutation UpdateItem($id: ID!, $version: Int) {
        updateItem(id: $id, input: { title: "Writer A", quantity: 100 }, _version: $version) {
          id
          quantity
          _version
        }
      }
    `,
      { id: recordId, version: currentVersion },
    );
    expect(resultA.errors).toBeUndefined();
    expect((resultA.data.updateItem as Record<string, unknown>)._version).toBe(4);

    // Writer B tries with the same stale version → conflict
    const resultB = await gql(
      `
      mutation UpdateItem($id: ID!, $version: Int) {
        updateItem(id: $id, input: { title: "Writer B", quantity: 200 }, _version: $version) {
          id
          quantity
          _version
        }
      }
    `,
      { id: recordId, version: currentVersion },
    );
    expect(resultB.errors).toBeDefined();
    expect(resultB.errors?.[0].message).toContain("Version conflict");

    // Verify the record has Writer A's value
    const stored = await store.get("item", recordId);
    expect(stored.quantity).toBe(100);
    expect(stored._version).toBe(4);
  });
});
