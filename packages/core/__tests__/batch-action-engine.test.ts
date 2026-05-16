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
  mergePendingBatchEvents,
} from "../src/engine/batch-action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Test fixtures ────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────

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
  it("stamps batch.parentExecutionId and batch.index into each child meta", async () => {
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

// ── mergePendingBatchEvents tests ────────────────────────────

describe("mergePendingBatchEvents (Spec 04 §8.2)", () => {
  const tenantId = "t1";

  function makeEvent(
    type: string,
    recordId: string,
    entity = "product",
    tenant = tenantId,
  ): PendingEvent {
    return {
      type,
      payload: { entity, recordId, name: `item-${recordId}` },
      tenantId: tenant,
      sourceAction: "create_product",
      sourceExecutionId: `exec-${recordId}`,
    };
  }

  it("returns empty array for empty input", () => {
    expect(mergePendingBatchEvents([])).toEqual([]);
  });

  it("passes through non-record events unchanged", () => {
    const events: PendingEvent[] = [
      { type: "custom.alert", payload: { severity: "high" }, tenantId },
      { type: "action.succeeded", payload: { action: "x" }, tenantId },
    ];
    const result = mergePendingBatchEvents(events);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.type)).toEqual(["custom.alert", "action.succeeded"]);
  });

  it("keeps a single record event as-is (no batch wrapping for solo items)", () => {
    const events = [makeEvent("record.created", "r1")];
    const result = mergePendingBatchEvents(events);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.type).toBe("record.created");
  });

  it("merges multiple same-type same-entity events into individual + batch events", () => {
    const events = [
      makeEvent("record.created", "r1"),
      makeEvent("record.created", "r2"),
      makeEvent("record.created", "r3"),
    ];
    const result = mergePendingBatchEvents(events);

    // Individual events kept for back-compat
    const individual = result.filter((e) => e.type === "record.created");
    expect(individual).toHaveLength(3);

    // One batch event added
    const batch = result.filter((e) => e.type === "record.batch_created");
    expect(batch).toHaveLength(1);
    const batchEvent = batch.at(0);
    expect(batchEvent?.payload.recordIds).toEqual(["r1", "r2", "r3"]);
    expect(batchEvent?.payload.count).toBe(3);
    expect(batchEvent?.payload.entity).toBe("product");
    expect(batchEvent?.tenantId).toBe(tenantId);
  });

  it("maps each record event type to the correct batch type", () => {
    const created = [makeEvent("record.created", "c1"), makeEvent("record.created", "c2")];
    const updated = [makeEvent("record.updated", "u1"), makeEvent("record.updated", "u2")];
    const deleted = [makeEvent("record.deleted", "d1"), makeEvent("record.deleted", "d2")];

    const result = mergePendingBatchEvents([...created, ...updated, ...deleted]);

    expect(result.some((e) => e.type === "record.batch_created")).toBe(true);
    expect(result.some((e) => e.type === "record.batch_updated")).toBe(true);
    expect(result.some((e) => e.type === "record.batch_deleted")).toBe(true);
  });

  it("groups events separately by entity", () => {
    const productEvents = [
      makeEvent("record.created", "p1", "product"),
      makeEvent("record.created", "p2", "product"),
    ];
    const orderEvents = [
      makeEvent("record.created", "o1", "order"),
      makeEvent("record.created", "o2", "order"),
    ];

    const result = mergePendingBatchEvents([...productEvents, ...orderEvents]);

    const batches = result.filter((e) => e.type === "record.batch_created");
    expect(batches).toHaveLength(2);
    const productBatch = batches.find((e) => e.payload.entity === "product");
    const orderBatch = batches.find((e) => e.payload.entity === "order");
    expect(productBatch?.payload.recordIds).toEqual(["p1", "p2"]);
    expect(orderBatch?.payload.recordIds).toEqual(["o1", "o2"]);
  });

  it("groups events separately by tenantId", () => {
    const tenant1Events = [
      makeEvent("record.created", "r1", "product", "tenant-1"),
      makeEvent("record.created", "r2", "product", "tenant-1"),
    ];
    const tenant2Events = [
      makeEvent("record.created", "r3", "product", "tenant-2"),
      makeEvent("record.created", "r4", "product", "tenant-2"),
    ];

    const result = mergePendingBatchEvents([...tenant1Events, ...tenant2Events]);

    const batches = result.filter((e) => e.type === "record.batch_created");
    expect(batches).toHaveLength(2);
    expect(batches.find((e) => e.tenantId === "tenant-1")?.payload.recordIds).toEqual(["r1", "r2"]);
    expect(batches.find((e) => e.tenantId === "tenant-2")?.payload.recordIds).toEqual(["r3", "r4"]);
  });

  it("preserves non-record events alongside merged batch events", () => {
    const events: PendingEvent[] = [
      { type: "custom.webhook", payload: { url: "https://example.com" }, tenantId },
      makeEvent("record.created", "r1"),
      makeEvent("record.created", "r2"),
    ];

    const result = mergePendingBatchEvents(events);
    expect(result.some((e) => e.type === "custom.webhook")).toBe(true);
    expect(result.some((e) => e.type === "record.batch_created")).toBe(true);
  });

  it("includes records array in batch event payload", () => {
    const events = [makeEvent("record.created", "r1"), makeEvent("record.created", "r2")];
    const result = mergePendingBatchEvents(events);

    const batch = result.find((e) => e.type === "record.batch_created");
    expect(batch).toBeDefined();
    expect(Array.isArray(batch?.payload.records)).toBe(true);
    expect((batch?.payload.records as unknown[])?.length).toBe(2);
  });

  it("preserves original event order and appends batch events at the end", () => {
    const events: PendingEvent[] = [
      { type: "custom.hook", payload: { step: 1 }, tenantId },
      makeEvent("record.created", "r1"),
      { type: "custom.hook", payload: { step: 2 }, tenantId },
      makeEvent("record.created", "r2"),
    ];

    const result = mergePendingBatchEvents(events);

    // Original events must appear in original order at the start
    expect(result[0]?.type).toBe("custom.hook");
    expect(result[0]?.payload.step).toBe(1);
    expect(result[1]?.type).toBe("record.created");
    expect(result[1]?.payload.recordId).toBe("r1");
    expect(result[2]?.type).toBe("custom.hook");
    expect(result[2]?.payload.step).toBe(2);
    expect(result[3]?.type).toBe("record.created");
    expect(result[3]?.payload.recordId).toBe("r2");
    // Batch event appended after all originals
    expect(result[4]?.type).toBe("record.batch_created");
    expect(result).toHaveLength(5);
  });

  it("propagates sourceAction, traceId, and meta from first event in group", () => {
    const events: PendingEvent[] = [
      {
        type: "record.created",
        payload: { entity: "product", recordId: "r1" },
        tenantId,
        sourceAction: "bulk_import",
        traceId: "trace-abc",
      },
      {
        type: "record.created",
        payload: { entity: "product", recordId: "r2" },
        tenantId,
        sourceAction: "bulk_import",
        traceId: "trace-abc",
      },
    ];

    const result = mergePendingBatchEvents(events);
    const batch = result.find((e) => e.type === "record.batch_created");
    expect(batch).toBeDefined();
    expect(batch?.sourceAction).toBe("bulk_import");
    expect(batch?.traceId).toBe("trace-abc");
  });
});
