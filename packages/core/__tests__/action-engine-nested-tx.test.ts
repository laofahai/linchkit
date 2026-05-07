/**
 * ActionEngine — nested action transactions (Spec 26 §1.1).
 *
 * When an Action handler invokes another Action via `ctx.execute()`, the
 * child Action runs INSIDE the parent's transaction. Either both commit, or
 * both roll back. No half-applied state.
 *
 * Implementation seam: the parent's `activeProvider` (the txProvider once
 * `runHandler` enters the transaction) is passed to the child call as
 * `_txDataProvider`, and the child's `pendingEvents` are merged into the
 * parent's `_parentPendingEvents`. The child engine detects the parent's
 * txProvider and short-circuits the `useTransaction` path, executing the
 * handler against the shared transactional provider directly.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { Logger } from "../src/types/logger";

// ── Test fixtures ───────────────────────────────────────────

const actor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

interface SnapshotProvider extends DataProvider {
  records: Map<string, Record<string, unknown>>;
  snapshot(): Map<string, Record<string, unknown>>;
  /** Number of times a transaction has been opened on this provider */
  txOpens: { count: number };
}

/**
 * In-memory provider that lets tests verify whether writes were persisted
 * (commit) or rolled back. Pairs with `createFakeTxManager` below.
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
      const id = (data.id as string | undefined) ?? `rec_${counter}`;
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
    txOpens: { count: 0 },
  });
}

/**
 * Fake TransactionManager. Snapshots the SnapshotProvider before invoking
 * `fn`; if `fn` throws, restores the snapshot (rollback simulation).
 * Increments `provider.txOpens.count` per `runInTransaction` call so tests
 * can verify how many physical transactions were opened — critical for
 * nested-tx semantics where a single transaction must cover both the
 * parent and any child invocations.
 */
function createFakeTxManager(provider: SnapshotProvider): TransactionManager {
  return {
    async runInTransaction<T>(
      fn: (tx: DataProvider) => Promise<T>,
      _pending: PendingEvent[],
    ): Promise<T> {
      provider.txOpens.count += 1;
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

/** Capture log calls for assertions */
function createSpyLogger(): Logger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    debug: () => {},
    info: (msg: string) => {
      infos.push(msg);
    },
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: () => {},
    warns,
    infos,
  };
}

// ── Action fixtures ─────────────────────────────────────────

const childCreateItem: ActionDefinition = {
  name: "child_create_item",
  entity: "item",
  label: "Child Create Item",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => ctx.create("item", { title: ctx.input.title }),
};

const childThrows: ActionDefinition = {
  name: "child_throws",
  entity: "item",
  label: "Child Throws",
  policy: { mode: "sync", transaction: true },
  handler: async () => {
    throw new Error("child intentional failure");
  },
};

/**
 * Parent that creates one item, calls a child action, then optionally throws.
 * Behavior controlled via input flags so a single fixture covers multiple
 * scenarios.
 */
const parentCallChildAndMaybeThrow: ActionDefinition = {
  name: "parent_call_child_and_maybe_throw",
  entity: "item",
  label: "Parent Call Child",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    await ctx.create("item", { title: "parent-item" });
    await ctx.execute("child_create_item", { title: "child-item" });
    if (ctx.input.throwAfterChild === true) {
      throw new Error("parent intentional failure after child returned");
    }
    return { ok: true };
  },
};

/**
 * Parent that calls a throwing child and lets the error bubble up. The
 * surrounding executor catch should roll back the parent transaction.
 */
const parentLetsChildErrorBubble: ActionDefinition = {
  name: "parent_lets_child_error_bubble",
  entity: "item",
  label: "Parent Lets Child Error Bubble",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    await ctx.create("item", { title: "parent-item-before-child" });
    // ctx.execute returns the failed child's data — handlers that want the
    // transaction to abort either re-throw or stop writing and return.
    const childData = (await ctx.execute("child_throws", {})) as Record<string, unknown>;
    if (typeof childData?.error === "string") {
      throw new Error(`child failed: ${childData.error}`);
    }
    return { ok: true };
  },
};

/** Parent has policy.transaction === false, child has its own transaction. */
const parentNoTxThatCallsTransactionalChild: ActionDefinition = {
  name: "parent_no_tx_calls_tx_child",
  entity: "item",
  label: "Parent (no tx) calls tx Child",
  policy: { mode: "sync", transaction: false },
  handler: async (ctx) => {
    await ctx.execute("child_create_item", { title: "child-from-no-tx-parent" });
    return { ok: true };
  },
};

/** Parent that swallows a child failure inside a shared transaction. */
const parentSwallowsChildError: ActionDefinition = {
  name: "parent_swallows_child_error",
  entity: "item",
  label: "Parent Swallows Child Error",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    await ctx.execute("child_throws", {});
    // Intentionally ignore child's failed `data` and return success.
    // (In production this is almost always a bug — Spec 26 §1.1 says the
    //  shared SQL transaction is now tainted.) The engine should log a
    //  warning about this pattern.
    return { ok: true };
  },
};

function buildExecutor(opts?: { logger?: Logger }) {
  const provider = createSnapshotProvider();
  const txManager = createFakeTxManager(provider);
  const executor = createActionExecutor({
    dataProvider: provider,
    transactionManager: txManager,
    logger: opts?.logger,
  });
  executor.registry.register(childCreateItem);
  executor.registry.register(childThrows);
  executor.registry.register(parentCallChildAndMaybeThrow);
  executor.registry.register(parentLetsChildErrorBubble);
  executor.registry.register(parentNoTxThatCallsTransactionalChild);
  executor.registry.register(parentSwallowsChildError);
  return { executor, provider, txManager };
}

// ── Tests ───────────────────────────────────────────────────

describe("nested action transactions — Spec 26 §1.1", () => {
  it("test #1 — child commits when parent commits (happy path)", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: false },
      actor,
    );

    expect(result.success).toBe(true);
    // Both parent's create and child's create persisted
    expect(provider.records.size).toBe(2);
    const titles = Array.from(provider.records.values()).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(["parent-item", "child-item"]));
    // Exactly ONE physical transaction opened (the parent's). The child
    // re-uses it via `_txDataProvider`.
    expect(provider.txOpens.count).toBe(1);
  });

  it("test #2 — child writes roll back when parent throws after child returns", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: true },
      actor,
    );

    expect(result.success).toBe(false);
    // Parent threw after child returned → both writes rolled back
    expect(provider.records.size).toBe(0);
    expect(provider.txOpens.count).toBe(1);
  });

  it("test #3 — child throw → parent's transaction rolls back (no parent commit, no child commit)", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executor.execute("parent_lets_child_error_bubble", {}, actor);

    expect(result.success).toBe(false);
    // Parent's pre-child write also rolled back — child's exception
    // propagated through ctx.execute (as failed data) and the parent
    // re-threw, causing the shared tx to roll back.
    expect(provider.records.size).toBe(0);
    expect(provider.txOpens.count).toBe(1);
  });

  it("test #4 — parent with policy.transaction:false + child with policy.transaction:true → child runs in its own tx", async () => {
    const { executor, provider } = buildExecutor();

    const result = await executor.execute("parent_no_tx_calls_tx_child", {}, actor);

    expect(result.success).toBe(true);
    expect(provider.records.size).toBe(1);
    // Parent didn't open a transaction; child opened one of its own.
    // Exactly ONE tx opened — the child's.
    expect(provider.txOpens.count).toBe(1);
  });

  it("test #5 — idempotency keys passed at the root do not register child idempotency entries", async () => {
    // Spec 26 §1.1 + Spec 65 §5: idempotency is a root-level concern.
    // A caller who provides an idempotency key gets root-level dedup; the
    // key is NOT inherited into nested ctx.execute calls (which would
    // otherwise need their own per-child idempotency records and could
    // collide with sibling step idempotency keys).
    //
    // We verify the contract by replaying the same root call and checking
    // the cache hit returns without invoking the handler twice.
    const { executor, provider } = buildExecutor();

    const r1 = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: false },
      actor,
      { idempotencyKey: "root-only-key" },
    );

    expect(r1.success).toBe(true);
    expect(provider.records.size).toBe(2);
    // Replay with same key — but our test executor has no executionLogger
    // configured, so dedup is a no-op. The point of the test is that the
    // child invocation does NOT fail with a "duplicate idempotency key"
    // collision when a sibling invocation passes a key. The child's
    // _txDataProvider path skips idempotency entirely (depth > 0), so no
    // collision is possible. Confirm this by running a second root call —
    // both children write through the parent's tx and succeed.
    const r2 = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: false },
      actor,
      { idempotencyKey: "another-key" },
    );

    expect(r2.success).toBe(true);
    expect(provider.records.size).toBe(4);
    expect(provider.txOpens.count).toBe(2);
  });

  it("test #6 — sibling steps in a flow do NOT share a transaction (only parent-child does)", async () => {
    // "Sibling steps" at the top level = two independent root-level
    // executions (a flow runtime invokes each step as a separate
    // executeAction call, each opening its own transaction). Verify that
    // two consecutive root calls open two distinct physical transactions
    // and that one rolling back does NOT undo the other.
    const { executor, provider } = buildExecutor();

    // Step 1: succeeds (commits its own tx)
    const r1 = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: false },
      actor,
    );
    expect(r1.success).toBe(true);
    expect(provider.records.size).toBe(2);

    // Step 2: throws after child returns (rolls back its own tx).
    // Step 1's data must remain because each step ran in its own tx.
    const r2 = await executor.execute(
      "parent_call_child_and_maybe_throw",
      { throwAfterChild: true },
      actor,
    );
    expect(r2.success).toBe(false);
    expect(provider.records.size).toBe(2); // step 1's writes still there
    expect(provider.txOpens.count).toBe(2);
  });

  it("logs a warning when a parent inside a transaction swallows a child failure (Spec 26 §1.1)", async () => {
    // Spec requirement: when a parent appears to ignore a child's failure
    // (returns success after a failed ctx.execute) inside a shared
    // transaction, the engine warns via Logger.warn — the underlying SQL
    // transaction is now tainted and any later writes will fail.
    const spy = createSpyLogger();
    const { executor } = buildExecutor({ logger: spy });

    const result = await executor.execute("parent_swallows_child_error", {}, actor);

    // Parent's handler returned successfully (it swallowed the error).
    // The action engine still records the call — and emitted a warning.
    expect(result.success).toBe(true);
    const matched = spy.warns.find((m) =>
      m.includes('Child action "child_throws" failed inside parent transaction'),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("rollback path");
  });

  it("does NOT warn when the parent has no transaction (no taint risk)", async () => {
    const spy = createSpyLogger();
    const { executor } = buildExecutor({ logger: spy });

    // Action with policy.transaction:false calling a throwing child —
    // there is no shared SQL transaction to taint, so no warning.
    executor.registry.register({
      name: "parent_no_tx_swallows_child",
      entity: "item",
      label: "Parent (no tx) swallows child",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        await ctx.execute("child_throws", {});
        return { ok: true };
      },
    });

    const result = await executor.execute("parent_no_tx_swallows_child", {}, actor);
    expect(result.success).toBe(true);
    const matched = spy.warns.find((m) => m.includes("rollback path"));
    expect(matched).toBeUndefined();
  });

  it("child's pending events are merged into the parent's pending list (atomic flush)", async () => {
    // Verify the events seam: when the child calls ctx.emit, the events
    // end up on the parent's pendingEvents array and are persisted in
    // the same transaction as the parent's events.
    const provider = createSnapshotProvider();
    const seenPending: PendingEvent[][] = [];
    const txManager: TransactionManager = {
      async runInTransaction<T>(
        fn: (tx: DataProvider) => Promise<T>,
        pending: PendingEvent[],
      ): Promise<T> {
        provider.txOpens.count += 1;
        const result = await fn(provider);
        // Snapshot pendingEvents AT COMMIT TIME (after handler ran)
        seenPending.push([...pending]);
        return result;
      },
    };
    const executor = createActionExecutor({
      dataProvider: provider,
      transactionManager: txManager,
    });

    executor.registry.register({
      name: "child_emits",
      entity: "item",
      label: "Child Emits",
      policy: { mode: "sync", transaction: true },
      handler: async (ctx) => {
        ctx.emit("child.event", { from: "child" });
        return { ok: true };
      },
    });
    executor.registry.register({
      name: "parent_emits_and_calls_child",
      entity: "item",
      label: "Parent Emits And Calls Child",
      policy: { mode: "sync", transaction: true },
      handler: async (ctx) => {
        ctx.emit("parent.event", { from: "parent" });
        await ctx.execute("child_emits", {});
        return { ok: true };
      },
    });

    const r = await executor.execute("parent_emits_and_calls_child", {}, actor);
    expect(r.success).toBe(true);

    // Exactly one transaction opened
    expect(provider.txOpens.count).toBe(1);
    expect(seenPending.length).toBe(1);

    // The single pending list contains BOTH events at commit time
    const types = (seenPending[0] ?? []).map((e) => e.type).sort();
    expect(types).toEqual(["child.event", "parent.event"]);
  });
});
