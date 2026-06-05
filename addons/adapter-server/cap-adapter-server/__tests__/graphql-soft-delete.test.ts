/**
 * Tests for GraphQL soft delete behavior:
 * - Delete sets deleted_at, doesn't physically remove
 * - Deleted records excluded from list by default
 * - includeDeleted=true shows deleted records
 * - Restore clears deleted_at
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  InMemoryStore,
  PipelineError,
} from "@linchkit/core/server";
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
const BASE = "http://local.test";

beforeAll(() => {
  store = new InMemoryStore();
  executor = createActionExecutor({ dataProvider: store });

  for (const action of generateCrudActions(schema)) {
    executor.registry.register(action);
  }

  const graphqlSchema = buildGraphQLSchema([schema], { executor, dataProvider: store });
  app = createServer(graphqlSchema);
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await app.handle(
    new Request(`${BASE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
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

// ── Permission slot coverage for restore (PR #187) ──────────────────────────

/**
 * Regression test: the GraphQL `restore_*` mutation must flow through the
 * CommandLayer's permission slot with `includeDeleted=true` forwarded via
 * `CommandExecuteOptions`, rather than bypassing the pipeline through the
 * raw executor. See PR #187.
 */
describe("GraphQL restore goes through CommandLayer permission slot", () => {
  let pipelineStore: InMemoryStore;
  let pipelineApp: ReturnType<typeof createServer>;
  /** Records of each permission middleware invocation on this pipeline. */
  const permissionCalls: Array<{ command: string; includeDeletedOnInput: unknown }> = [];
  /** When true, the permission middleware denies `restore_*` commands. */
  let denyRestore = false;

  beforeAll(() => {
    pipelineStore = new InMemoryStore();
    const executor = createActionExecutor({ dataProvider: pipelineStore });
    for (const action of generateCrudActions(schema)) {
      executor.registry.register(action);
    }

    const commandLayer = createCommandLayer({ executor });
    commandLayer.use({
      name: "record_permission_calls",
      slot: "permission",
      handler: async (ctx, next) => {
        permissionCalls.push({
          command: ctx.command,
          includeDeletedOnInput: (ctx.input as Record<string, unknown>).includeDeleted,
        });
        if (denyRestore && ctx.command.startsWith("restore_")) {
          throw new PipelineError(
            "restore denied by test permission middleware",
            "PERMISSION.DENIED",
          );
        }
        await next();
      },
    });

    const graphqlSchema = buildGraphQLSchema([schema], {
      executor,
      commandLayer,
      dataProvider: pipelineStore,
    });

    pipelineApp = createServer(graphqlSchema, {
      executor,
      commandLayer,
      dataProvider: pipelineStore,
    });
  });

  beforeEach(() => {
    pipelineStore.clear();
    permissionCalls.length = 0;
    denyRestore = false;
  });

  async function gqlPipeline(query: string) {
    const res = await pipelineApp.handle(
      new Request(`${BASE}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    );
    return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
  }

  test("restore mutation invokes the permission slot and forwards includeDeleted", async () => {
    await pipelineStore.create(SCHEMA_NAME, {
      id: "pipeline_restore",
      title: "Pipeline Restore",
      quantity: 3,
    });
    await pipelineStore.delete(SCHEMA_NAME, "pipeline_restore");

    const result = await gqlPipeline(`
      mutation {
        restoreSoftDelItem(id: "pipeline_restore") {
          id
          title
        }
      }
    `);
    expect(result.errors).toBeUndefined();
    const restored = result.data.restoreSoftDelItem as Record<string, unknown>;
    expect(restored.id).toBe("pipeline_restore");
    expect(restored.title).toBe("Pipeline Restore");

    // Permission slot was invoked for the restore action.
    const restoreCall = permissionCalls.find((c) => c.command === "restore_soft_del_item");
    expect(restoreCall).toBeDefined();

    // The deleted row is only reachable when the executor sees includeDeleted=true;
    // a successful restore therefore proves the flag was forwarded through
    // CommandExecuteOptions rather than dropped at the pipeline boundary.
    const raw = await pipelineStore.get(SCHEMA_NAME, "pipeline_restore");
    expect(raw).toBeDefined();
    expect(raw.deleted_at).toBeNull();
  });

  test("permission slot can deny restore, blocking the executor entirely", async () => {
    await pipelineStore.create(SCHEMA_NAME, {
      id: "denied_restore",
      title: "Denied Restore",
      quantity: 2,
    });
    await pipelineStore.delete(SCHEMA_NAME, "denied_restore");

    denyRestore = true;

    const result = await gqlPipeline(`
      mutation {
        restoreSoftDelItem(id: "denied_restore") {
          id
        }
      }
    `);
    // Either the response carries a GraphQL error or a null payload with the
    // denial propagated via the ActionResult — in both shapes the raw record
    // must remain soft-deleted.
    const payload = result.data?.restoreSoftDelItem ?? null;
    expect(payload === null || (result.errors && result.errors.length > 0)).toBe(true);

    const raw = await pipelineStore.get(SCHEMA_NAME, "denied_restore", { includeDeleted: true });
    expect(raw).toBeDefined();
    expect(raw.deleted_at).toBeDefined();
    expect(raw.deleted_at).not.toBeNull();
  });
});
