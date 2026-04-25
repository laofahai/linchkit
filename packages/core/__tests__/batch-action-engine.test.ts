/**
 * Tests for `executeBatch` (Spec 04 §8, Spec 16 §2.1).
 *
 * Covers strategy selection, transaction propagation via the existing
 * `_txDataProvider` seam in ActionExecutor, input validation, and meta
 * propagation of the parent execution ID.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import {
  BatchValidationError,
  executeBatch,
  MAX_BATCH_SIZE,
} from "../src/engine/batch-action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Test fixtures ───────────────────────────────────────────

const actor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

interface SnapshotProvider extends DataProvider {
  records: Map<string, Record<string, unknown>>;
  snapshot(): Map<string, Record<string, unknown>>;
}

/**
 * Tiny in-memory data provider that lets tests verify whether writes were
 * actually persisted (or rolled back). The store has no transaction
 * semantics on its own — the fake TransactionManager below pairs with it
 * to simulate commit/rollback.
 */
function createSnapshotProvider(): SnapshotProvider {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const provider: DataProvider = {
    async get(_schema: string, id: string) {
      const found = records.get(id);
      if (!found) throw new Error(`not found: ${id}`);
      return found;
    },
    async query() {
      return [];
    },
    async create(_schema: string, data: Record<string, unknown>) {
      counter++;
      const id = `rec_${counter}`;
      const rec = { id, ...data };
      records.set(id, rec);
      return rec;
    },
    async update(_schema: string, id: string, data: Record<string, unknown>) {
      const existing = records.get(id) ?? { id };
      const updated = { ...existing, ...data };
      records.set(id, updated);
      return updated;
    },
    async delete(_schema: string, id: string) {
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

/**
 * Fake TransactionManager. It snapshots the provided `SnapshotProvider`
 * before running `fn`; if `fn` throws, it restores the snapshot. This
 * mimics the rollback semantics we need for `all_or_nothing` tests
 * without bringing in a real DB.
 */
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
  handler: async (ctx) => ctx.create("item", { title: ctx.input.title }),
};

const updateItem: ActionDefinition = {
  name: "update_item",
  entity: "item",
  label: "Update Item",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    return ctx.update("item", id, { title: ctx.input.title });
  },
};

const failingItem: ActionDefinition = {
  name: "fail_item",
  entity: "item",
  label: "Fail Item",
  policy: { mode: "sync", transaction: true },
  handler: async () => {
    throw new Error("intentional failure");
  },
};

function buildExecutor() {
  const provider = createSnapshotProvider();
  const txManager = createFakeTxManager(provider);
  const executor = createActionExecutor({
    dataProvider: provider,
    transactionManager: txManager,
  });
  executor.registry.register(createItem);
  executor.registry.register(updateItem);
  executor.registry.register(failingItem);
  return { executor, provider, txManager };
}

// ── Tests ───────────────────────────────────────────────────

describe("executeBatch — partial strategy", () => {
  it("returns success=true when all items succeed", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executeBatch(
      {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "A" } },
          { name: "create_item", input: { title: "B" } },
          { name: "create_item", input: { title: "C" } },
        ],
      },
      { executor, actor },
    );

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("partial");
    expect(result.succeeded.length).toBe(3);
    expect(result.failed.length).toBe(0);
    expect(result.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(provider.records.size).toBe(3);
    // Each item gets its own executionId
    const ids = new Set(result.succeeded.map((s) => s.executionId));
    expect(ids.size).toBe(3);
  });

  it("continues on failure and reports per-item details", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executeBatch(
      {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "A" } },
          { name: "fail_item", input: {} },
          { name: "create_item", input: { title: "C" } },
        ],
      },
      { executor, actor },
    );

    expect(result.success).toBe(false);
    expect(result.succeeded.length).toBe(2);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.index).toBe(1);
    expect(result.failed[0]?.error.message).toContain("intentional failure");
    // Items 0 and 2 should have persisted (each ran in its own tx).
    expect(provider.records.size).toBe(2);
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
  });
});

describe("executeBatch — all_or_nothing strategy", () => {
  it("commits all items inside one shared transaction", async () => {
    const { executor, provider, txManager } = buildExecutor();

    const result = await executeBatch(
      {
        strategy: "all_or_nothing",
        actions: [
          { name: "create_item", input: { title: "A" } },
          { name: "create_item", input: { title: "B" } },
          { name: "create_item", input: { title: "C" } },
        ],
      },
      { executor, actor, transactionManager: txManager },
    );

    expect(result.success).toBe(true);
    expect(result.succeeded.length).toBe(3);
    expect(result.failed.length).toBe(0);
    expect(provider.records.size).toBe(3);
  });

  it("rolls back earlier successful items when a later item fails", async () => {
    const { executor, provider, txManager } = buildExecutor();

    const result = await executeBatch(
      {
        strategy: "all_or_nothing",
        actions: [
          { name: "create_item", input: { title: "A" } },
          { name: "create_item", input: { title: "B" } },
          { name: "fail_item", input: {} },
          { name: "create_item", input: { title: "D" } },
        ],
      },
      { executor, actor, transactionManager: txManager },
    );

    expect(result.success).toBe(false);
    expect(result.strategy).toBe("all_or_nothing");
    expect(result.succeeded.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.index).toBe(2);
    // The two items that ran successfully before the abort surface via rolledBack.
    expect(result.rolledBack?.length).toBe(2);
    expect(result.rolledBack?.[0]?.index).toBe(0);
    expect(result.rolledBack?.[1]?.index).toBe(1);
    // No records persisted — fake tx manager restores the pre-batch snapshot.
    expect(provider.records.size).toBe(0);
  });

  it("default strategy is all_or_nothing", async () => {
    const { executor, txManager, provider } = buildExecutor();

    const result = await executeBatch(
      {
        actions: [{ name: "create_item", input: { title: "A" } }],
      },
      { executor, actor, transactionManager: txManager },
    );

    expect(result.strategy).toBe("all_or_nothing");
    expect(result.success).toBe(true);
    expect(provider.records.size).toBe(1);
  });

  it("throws when no transactionManager is provided", async () => {
    const { executor } = buildExecutor();

    expect(
      executeBatch(
        {
          strategy: "all_or_nothing",
          actions: [{ name: "create_item", input: { title: "A" } }],
        },
        { executor, actor },
      ),
    ).rejects.toThrow(/all_or_nothing strategy requires a TransactionManager/);
  });
});

describe("executeBatch — input validation", () => {
  it("throws BATCH_EMPTY when actions is empty", async () => {
    const { executor, txManager } = buildExecutor();

    let caught: unknown;
    try {
      await executeBatch(
        { strategy: "partial", actions: [] },
        { executor, actor, transactionManager: txManager },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BatchValidationError);
    expect((caught as BatchValidationError).code).toBe("BATCH_EMPTY");
  });

  it("throws BATCH_TOO_LARGE when actions exceed MAX_BATCH_SIZE", async () => {
    const { executor, txManager } = buildExecutor();

    const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({
      name: "create_item",
      input: { title: "x" },
    }));

    let caught: unknown;
    try {
      await executeBatch(
        { strategy: "partial", actions: oversized },
        { executor, actor, transactionManager: txManager },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BatchValidationError);
    expect((caught as BatchValidationError).code).toBe("BATCH_TOO_LARGE");
  });
});

describe("executeBatch — meta propagation", () => {
  it("stamps _batch.parentExecutionId and _batch.index into each child meta", async () => {
    const provider = createSnapshotProvider();
    const seenMetas: Array<{ parent?: unknown; index?: unknown }> = [];

    const recordingAction: ActionDefinition = {
      name: "record_meta",
      entity: "item",
      label: "Record Meta",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        seenMetas.push({
          parent: ctx.meta.get("batch.parentExecutionId"),
          index: ctx.meta.get("batch.index"),
        });
        return { ok: true };
      },
    };

    const executor = createActionExecutor({ dataProvider: provider });
    executor.registry.register(recordingAction);

    const result = await executeBatch(
      {
        strategy: "partial",
        actions: [
          { name: "record_meta", input: {} },
          { name: "record_meta", input: {} },
          { name: "record_meta", input: {} },
        ],
      },
      { executor, actor },
    );

    expect(result.success).toBe(true);
    expect(seenMetas.length).toBe(3);
    // Same parent across all items
    const parents = new Set(seenMetas.map((m) => m.parent));
    expect(parents.size).toBe(1);
    const parent = [...parents][0];
    expect(parent).toBe(result.parentExecutionId);
    // Each item sees its index
    expect(seenMetas.map((m) => m.index)).toEqual([0, 1, 2]);
  });
});

describe("executeBatch — mixed action types", () => {
  it("supports different actions in one batch (partial)", async () => {
    const { executor, provider } = buildExecutor();
    // Pre-create a record so update_item has something to update.
    await executor.execute("create_item", { title: "Seed" }, actor);

    const id = [...provider.records.keys()][0];
    if (!id) throw new Error("seed record missing");

    const result = await executeBatch(
      {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "New" } },
          { name: "update_item", input: { id, title: "Renamed" } },
        ],
      },
      { executor, actor },
    );

    expect(result.success).toBe(true);
    expect(result.succeeded.length).toBe(2);
    const renamed = provider.records.get(id);
    expect(renamed?.title).toBe("Renamed");
  });
});
