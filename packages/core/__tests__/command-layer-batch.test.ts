/**
 * Tests for `CommandLayer.executeBatch` (Spec 04 §8, Spec 16 §2.1).
 *
 * Covers permission-slot integration (per-item denial), tenant scoping
 * applied per item, actor propagation, and the same `all_or_nothing`
 * vs `partial` semantics validated at the executor level — but here
 * exercised through the full pipeline.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import { createCommandLayer, PipelineError } from "../src/engine/command-layer";
import type { ActionDefinition, Actor } from "../src/types/action";

const adminActor: Actor = { type: "human", id: "u1", groups: ["admin"] };
const restrictedActor: Actor = { type: "human", id: "u2", groups: ["user"] };

interface SnapshotProvider extends DataProvider {
  records: Map<string, Record<string, unknown>>;
  snapshot(): Map<string, Record<string, unknown>>;
}

function createSnapshotProvider(): SnapshotProvider {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const provider: DataProvider = {
    async get(_schema, id) {
      const found = records.get(id);
      if (!found) throw new Error(`not found: ${id}`);
      return found;
    },
    async query() {
      return [];
    },
    async create(_schema, data) {
      counter++;
      const id = `rec_${counter}`;
      const rec = { id, ...data };
      records.set(id, rec);
      return rec;
    },
    async update(_schema, id, data) {
      const existing = records.get(id) ?? { id };
      const updated = { ...existing, ...data };
      records.set(id, updated);
      return updated;
    },
    async delete(_schema, id) {
      records.delete(id);
    },
    async count() {
      return records.size;
    },
  };
  return Object.assign(provider, {
    records,
    snapshot: () => new Map(records),
  });
}

function createFakeTxManager(provider: SnapshotProvider): TransactionManager {
  return {
    async runInTransaction<T>(
      fn: (tx: DataProvider) => Promise<T>,
      _pending: PendingEvent[],
    ): Promise<T> {
      const before = provider.snapshot();
      try {
        return await fn(provider);
      } catch (err) {
        provider.records.clear();
        for (const [k, v] of before) provider.records.set(k, v);
        throw err;
      }
    },
  };
}

const createItem: ActionDefinition = {
  name: "create_item",
  entity: "item",
  label: "Create Item",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("item", { title: ctx.input.title });
  },
};

const restrictedAction: ActionDefinition = {
  name: "delete_item",
  entity: "item",
  label: "Delete Item",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("item", { tag: "restricted", input: ctx.input });
  },
};

function buildSetup() {
  const provider = createSnapshotProvider();
  const txManager = createFakeTxManager(provider);
  const executor = createActionExecutor({
    dataProvider: provider,
    transactionManager: txManager,
  });
  executor.registry.register(createItem);
  executor.registry.register(restrictedAction);

  const layer = createCommandLayer({ executor });
  // Permission middleware: only admins can run delete_item.
  layer.use({
    name: "test_permission",
    slot: "permission",
    handler: async (ctx, next) => {
      if (ctx.command === "delete_item" && !ctx.actor.groups.includes("admin")) {
        throw new PipelineError(
          "Actor does not belong to required group: admin",
          "PERMISSION.DENIED",
        );
      }
      await next();
    },
  });
  return { provider, txManager, executor, layer };
}

describe("CommandLayer.executeBatch — permission slot per item", () => {
  it("partial: per-item permission failure is recorded, others succeed", async () => {
    const { layer, provider } = buildSetup();

    const result = await layer.executeBatch({
      input: {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "ok-1" } },
          { name: "delete_item", input: { id: "x" } },
          { name: "create_item", input: { title: "ok-2" } },
        ],
      },
      actor: restrictedActor,
    });

    expect(result.success).toBe(false);
    expect(result.succeeded.length).toBe(2);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.index).toBe(1);
    expect(result.failed[0]?.error.code).toBe("PERMISSION.DENIED");
    // Two persisted items.
    expect(provider.records.size).toBe(2);
  });

  it("all_or_nothing: permission failure rolls back the whole batch", async () => {
    const { layer, provider, txManager } = buildSetup();

    const result = await layer.executeBatch({
      input: {
        strategy: "all_or_nothing",
        actions: [
          { name: "create_item", input: { title: "ok-1" } },
          { name: "create_item", input: { title: "ok-2" } },
          { name: "delete_item", input: { id: "x" } },
        ],
      },
      actor: restrictedActor,
      transactionManager: txManager,
    });

    expect(result.success).toBe(false);
    expect(result.succeeded.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.index).toBe(2);
    expect(result.failed[0]?.error.code).toBe("PERMISSION.DENIED");
    expect(result.rolledBack?.length).toBe(2);
    // Snapshot rollback wipes the previously created records.
    expect(provider.records.size).toBe(0);
  });
});

describe("CommandLayer.executeBatch — actor and tenant propagation", () => {
  it("propagates the supplied actor to every item", async () => {
    const provider = createSnapshotProvider();
    const txManager = createFakeTxManager(provider);
    const executor = createActionExecutor({
      dataProvider: provider,
      transactionManager: txManager,
    });

    const seenActors: Actor[] = [];
    const recordingAction: ActionDefinition = {
      name: "record_actor",
      entity: "item",
      label: "Record Actor",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        seenActors.push(ctx.actor);
        return { ok: true };
      },
    };
    executor.registry.register(recordingAction);

    const layer = createCommandLayer({ executor });
    const result = await layer.executeBatch({
      input: {
        strategy: "partial",
        actions: [
          { name: "record_actor", input: {} },
          { name: "record_actor", input: {} },
        ],
      },
      actor: adminActor,
    });

    expect(result.success).toBe(true);
    expect(seenActors.length).toBe(2);
    for (const a of seenActors) {
      expect(a.id).toBe(adminActor.id);
      expect(a.groups).toEqual(adminActor.groups);
    }
  });

  it("applies tenantId to every item via tenant-scoped writes", async () => {
    const provider = createSnapshotProvider();
    const executor = createActionExecutor({ dataProvider: provider });
    executor.registry.register(createItem);

    const layer = createCommandLayer({ executor });
    // Tenant middleware sets ctx.tenantId from a header (test sim — directly forwarded).
    layer.use({
      name: "test_tenant",
      slot: "tenant",
      handler: async (ctx, next) => {
        if (!ctx.tenantId && ctx.headers?.["x-tenant"]) {
          ctx.tenantId = ctx.headers["x-tenant"];
        }
        await next();
      },
    });

    const result = await layer.executeBatch({
      input: {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "A" } },
          { name: "create_item", input: { title: "B" } },
        ],
      },
      actor: adminActor,
      headers: { "x-tenant": "tenant-1" },
    });

    expect(result.success).toBe(true);
    // Tenant isolation injects tenant_id on create.
    for (const rec of provider.records.values()) {
      expect(rec.tenant_id).toBe("tenant-1");
    }
  });
});

describe("CommandLayer.executeBatch — input validation", () => {
  it("rejects empty actions array with structured failure", async () => {
    const { layer } = buildSetup();
    const result = await layer.executeBatch({
      input: { actions: [] },
      actor: adminActor,
    });
    expect(result.success).toBe(false);
    expect(result.failed[0]?.error.code).toBe("BATCH_EMPTY");
  });

  it("rejects all_or_nothing without transactionManager with structured failure", async () => {
    const { layer } = buildSetup();
    const result = await layer.executeBatch({
      input: {
        strategy: "all_or_nothing",
        actions: [{ name: "create_item", input: { title: "a" } }],
      },
      actor: adminActor,
      // intentionally omit transactionManager
    });
    expect(result.success).toBe(false);
    expect(result.failed[0]?.error.code).toBe("BATCH_TX_MANAGER_REQUIRED");
  });
});
