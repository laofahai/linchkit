/**
 * Record-state guard rules are re-evaluated inside the write transaction for
 * NESTED transactional actions too (#473), extending the #462 / #466 / #470
 * top-level guarantee.
 *
 * A NESTED action — invoked via `ctx.execute(child)` from a parent handler that
 * is itself inside an open transaction — already reads its guarded record
 * through the parent's transactional provider at Step 4c, so its snapshot is
 * fresh/in-transaction. The remaining gap is purely the LOCK: that Step 4c read
 * is a plain `SELECT` (no `FOR UPDATE`), so under READ COMMITTED a concurrent
 * external commit can still race between the nested guard read and the nested
 * write. The in-transaction re-check now runs for nested actions as well and
 * issues the guard read with `forUpdate: true`, pinning the row in the parent's
 * transaction until commit.
 *
 * These tests model the nesting with a transactional PARENT action whose handler
 * calls `ctx.execute("child_approve", ...)`. The engine forwards the parent's
 * transactional provider as the child's `_txDataProvider`, so the child runs
 * with `parentTxProvider` set — i.e. the nested path. We capture the read
 * options on the provider the child reads through to prove the lock now extends
 * to nested.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type DataQueryOptions,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";

const actor: Actor = { type: "human", id: "u1", groups: [] };

interface Cap {
  updated: boolean;
}

/**
 * Provider that always reads `record` and records whether `update` ran. When a
 * `getOptionsLog` is supplied, every `get()` call appends the options it received
 * so a test can assert how the read was issued (e.g. `forUpdate`).
 */
function makeProvider(
  record: Record<string, unknown>,
  cap: Cap,
  getOptionsLog?: Array<DataQueryOptions | undefined>,
): DataProvider {
  return {
    get: async (_entity, id, options) => {
      getOptionsLog?.push(options);
      return { id, ...record };
    },
    query: async () => [],
    create: async (_entity, data) => ({ id: "r1", ...data }),
    update: async (_entity, id, data) => {
      cap.updated = true;
      return { id, ...record, ...data };
    },
    delete: async () => {},
    count: async () => 0,
  };
}

/** A TransactionManager whose transactional provider exposes the FRESH snapshot. */
function makeTxManager(txProvider: DataProvider): TransactionManager {
  return {
    runInTransaction: <T>(fn: (tx: DataProvider) => Promise<T>, _events: PendingEvent[]) =>
      fn(txProvider),
  };
}

/** block when the CURRENT record state is already "approved" — a record-state guard. */
function blockIfApproved(): RuleDefinition {
  return {
    name: "block_if_already_approved",
    label: "Block double approval",
    trigger: { action: "child_approve" },
    condition: { field: "target.status", operator: "eq", value: "approved" },
    effect: { type: "block", message: "Already approved", reason: "already_approved" },
  };
}

/**
 * CHILD transactional update action carrying the record-state guard — writes via
 * ctx.update so a write is detectable.
 */
function childApproveAction(): ActionDefinition {
  return {
    name: "child_approve",
    entity: "thing",
    label: "Approve (child)",
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const input = ctx.input as { id: string };
      return ctx.update("thing", input.id, { status: "done" });
    },
  };
}

/**
 * PARENT transactional action with NO guard rules. Its handler invokes the child
 * via ctx.execute, which forwards the parent's transactional provider so the
 * child runs nested (parentTxProvider set). Returns the child's result so the
 * test can inspect it.
 */
function parentApproveAction(): ActionDefinition {
  return {
    name: "parent_approve",
    entity: "thing",
    label: "Approve (parent)",
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const child = await ctx.execute("child_approve", { id: "c1" });
      return { child };
    },
  };
}

describe("nested transactional record-state guard re-check (#473 row-lock)", () => {
  it("the NESTED child's in-tx guard re-check reads FOR UPDATE through the parent tx provider", async () => {
    const baseGetOptions: Array<DataQueryOptions | undefined> = [];
    const txGetOptions: Array<DataQueryOptions | undefined> = [];
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    // Neither snapshot is "approved" → the guard does not fire and the write
    // proceeds, so the nested in-tx read is exercised without the block
    // short-circuiting. The child reads through the parent's tx provider, so the
    // `forUpdate` lock must appear on `txGetOptions`.
    const baseProvider = makeProvider({ status: "pending" }, baseCap, baseGetOptions);
    const txProvider = makeProvider({ status: "pending" }, txCap, txGetOptions);

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [blockIfApproved()],
    });
    executor.registry.register(childApproveAction());
    executor.registry.register(parentApproveAction());

    const result = await executor.execute("parent_approve", { id: "p1" }, actor);
    expect(result.success).toBe(true);
    // The child's nested write went through the parent's tx provider.
    expect(txCap.updated).toBe(true);

    // The nested child's in-tx guard re-check pinned the guarded row with a
    // `FOR UPDATE` lock so a concurrent writer can't flip its state before the
    // nested write (#473). Before the gate extension this would be absent — the
    // re-check was scoped to top-level transactional actions only.
    expect(txGetOptions.length).toBeGreaterThan(0);
    expect(txGetOptions.some((o) => o?.forUpdate === true)).toBe(true);
    // The parent is top-level transactional with no guard rules, so its only
    // read of the base (pre-tx) provider is the parent's pre-write Step 4c pass,
    // which runs OUTSIDE the transaction and must NOT request a row lock.
    expect(baseGetOptions.every((o) => !o?.forUpdate)).toBe(true);
  });

  it("a NESTED record-state block fires on the IN-TX snapshot and no child write occurs", async () => {
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    // Pre-tx base reads STALE "pending" → an old pre-tx-only read would NOT block.
    const baseProvider = makeProvider({ status: "pending" }, baseCap);
    // The transaction sees FRESH "approved" → the nested guard must block on this
    // in-tx snapshot, locked via FOR UPDATE.
    const txProvider = makeProvider({ status: "approved" }, txCap);

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [blockIfApproved()],
    });
    executor.registry.register(childApproveAction());
    executor.registry.register(parentApproveAction());

    const result = await executor.execute("parent_approve", { id: "p1" }, actor);

    // The nested child is blocked on the fresh in-tx snapshot. The block throws
    // InTxRuleBlockError, the transaction rolls back, and the child surfaces to
    // the parent as childResult.success === false (its `data` is the rule_block
    // failure that ctx.execute returns to the parent handler).
    const child = (result.data as { child?: { context?: { constraint?: string } } }).child;
    expect(child?.context?.constraint).toBe("rule_block");
    // No write happened on either provider.
    expect(baseCap.updated).toBe(false);
    expect(txCap.updated).toBe(false);
  });

  it("control: when the in-tx snapshot is NOT approved, the nested child proceeds and writes", async () => {
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    const baseProvider = makeProvider({ status: "pending" }, baseCap);
    const txProvider = makeProvider({ status: "pending" }, txCap);

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [blockIfApproved()],
    });
    executor.registry.register(childApproveAction());
    executor.registry.register(parentApproveAction());

    const result = await executor.execute("parent_approve", { id: "p1" }, actor);

    expect(result.success).toBe(true);
    // The nested write went through the (shared) transactional provider.
    expect(txCap.updated).toBe(true);
    expect(baseCap.updated).toBe(false);
  });
});
