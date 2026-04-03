/**
 * Tests for GraphQL soft delete behavior:
 * - Delete sets deleted_at, doesn't physically remove
 * - Deleted records excluded from list by default
 * - includeDeleted=true shows deleted records
 * - Restore clears deleted_at
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const schema: EntityDefinition = {
  name: "soft_del_item",
  label: "Soft Delete Item",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    quantity: { type: "number", label: "Quantity" },
  },
};

const SCHEMA_NAME = "soft_del_item";

let store: InMemoryStore;
let executor: ReturnType<typeof createActionExecutor>;
let app: ReturnType<typeof createServer>;
const port = 3991;

beforeAll(() => {
  store = new InMemoryStore();
  executor = createActionExecutor({ dataProvider: store });

  for (const action of generateCrudActions(schema)) {
    executor.registry.register(action);
  }

  const graphqlSchema = buildGraphQLSchema([schema], { executor, dataProvider: store });
  app = createServer(graphqlSchema);
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL soft delete", () => {
  test("delete sets deleted_at instead of physically removing the record", async () => {
    // Create a record
    const createResult = await gql(`
      mutation {
        createSoftDelItem(input: { title: "Widget", quantity: 10 }) {
          id
          title
        }
      }
    `);
    expect(createResult.errors).toBeUndefined();
    const itemId = (createResult.data.createSoftDelItem as Record<string, unknown>).id as string;

    // Delete it
    const deleteResult = await gql(`
      mutation {
        deleteSoftDelItem(id: "${itemId}")
      }
    `);
    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteSoftDelItem).toBe(true);

    // Verify the record still exists in the store with deleted_at set
    const raw = await store.get(SCHEMA_NAME, itemId, { includeDeleted: true });
    expect(raw).toBeDefined();
    expect(raw.deleted_at).toBeDefined();
    expect(raw.deleted_at).not.toBeNull();
    expect(raw.title).toBe("Widget");
  });

  test("deleted records are excluded from list queries by default", async () => {
    // Create two records
    await store.create(SCHEMA_NAME, { id: "keep", title: "Keeper", quantity: 1 });
    await store.create(SCHEMA_NAME, { id: "remove", title: "Removed", quantity: 2 });

    // Soft-delete one
    await store.delete(SCHEMA_NAME, "remove");

    // List should only show the non-deleted one
    const listResult = await gql(`
      query {
        softDelItemList {
          items { id title }
          total
        }
      }
    `);
    expect(listResult.errors).toBeUndefined();
    const list = listResult.data.softDelItemList as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe("keep");
  });

  test("deleted records are excluded from get queries by default", async () => {
    await store.create(SCHEMA_NAME, { id: "gone", title: "Gone", quantity: 0 });
    await store.delete(SCHEMA_NAME, "gone");

    // Get by ID should return null for soft-deleted record
    const getResult = await gql(`
      query {
        softDelItem(id: "gone") {
          id
          title
        }
      }
    `);
    expect(getResult.errors).toBeUndefined();
    expect(getResult.data.softDelItem).toBeNull();
  });

  test("includeDeleted=true shows deleted records in list", async () => {
    await store.create(SCHEMA_NAME, { id: "alive", title: "Alive", quantity: 5 });
    await store.create(SCHEMA_NAME, { id: "dead", title: "Dead", quantity: 3 });
    await store.delete(SCHEMA_NAME, "dead");

    // Without includeDeleted — should only show alive
    const normalList = await gql(`
      query {
        softDelItemList {
          items { id }
          total
        }
      }
    `);
    expect((normalList.data.softDelItemList as { total: number }).total).toBe(1);

    // With includeDeleted=true — should show both
    const allList = await gql(`
      query {
        softDelItemList(includeDeleted: true) {
          items { id title }
          total
        }
      }
    `);
    expect(allList.errors).toBeUndefined();
    const all = allList.data.softDelItemList as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);
    const ids = all.items.map((i) => i.id).sort();
    expect(ids).toEqual(["alive", "dead"]);
  });

  test("restore clears deleted_at and makes the record visible again", async () => {
    // Create and delete
    await store.create(SCHEMA_NAME, { id: "restore_me", title: "Restore Me", quantity: 7 });
    await store.delete(SCHEMA_NAME, "restore_me");

    // Verify it's not visible via get
    const beforeRestore = await gql(`
      query {
        softDelItem(id: "restore_me") { id }
      }
    `);
    expect(beforeRestore.data.softDelItem).toBeNull();

    // Restore it
    const restoreResult = await gql(`
      mutation {
        restoreSoftDelItem(id: "restore_me") {
          id
          title
          quantity
        }
      }
    `);
    expect(restoreResult.errors).toBeUndefined();
    const restored = restoreResult.data.restoreSoftDelItem as Record<string, unknown>;
    expect(restored.id).toBe("restore_me");
    expect(restored.title).toBe("Restore Me");
    expect(restored.quantity).toBe(7);

    // Verify the record is now visible in normal queries
    const afterRestore = await gql(`
      query {
        softDelItem(id: "restore_me") {
          id
          title
        }
      }
    `);
    expect(afterRestore.errors).toBeUndefined();
    expect((afterRestore.data.softDelItem as Record<string, unknown>).title).toBe("Restore Me");

    // Verify deleted_at is cleared in the store
    const raw = await store.get(SCHEMA_NAME, "restore_me");
    expect(raw.deleted_at).toBeNull();
  });

  test("restore on a non-deleted record is a no-op (returns the record)", async () => {
    await store.create(SCHEMA_NAME, { id: "not_deleted", title: "Active", quantity: 1 });

    const result = await gql(`
      mutation {
        restoreSoftDelItem(id: "not_deleted") {
          id
          title
        }
      }
    `);
    expect(result.errors).toBeUndefined();
    expect((result.data.restoreSoftDelItem as Record<string, unknown>).title).toBe("Active");
  });
});
