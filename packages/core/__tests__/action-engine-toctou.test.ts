/**
 * ActionEngine — TOCTOU hardening regression (issue #466, Spec 23 §1.1).
 *
 * Prior to the fix, `evaluateActionRules` was called with
 * `readProvider: parentTxProvider ?? baseProvider` OUTSIDE the write
 * transaction. For a top-level transactional action this meant the rule
 * read the record from `baseProvider` BEFORE `runInTransaction` opened,
 * then the write committed INSIDE the transaction — a window where a
 * concurrent commit could change the record between the rule read and the
 * write, causing a record-state `block`/`require_approval` guard to make
 * its decision on stale data.
 *
 * After the fix: `runPipelineWithProvider(dp)` passes the DataProvider `dp`
 * all the way through Steps 4c–7. For the top-level transactional path `dp`
 * IS the txProvider that `runInTransaction` opens, so the rule read and the
 * write share the same snapshot.
 *
 * This file contains one critical regression test: it proves that for a
 * top-level transactional action the rule receives a record read via the
 * txProvider, NOT via the baseProvider. It does this by giving them
 * divergent state and asserting the tx-side state wins.
 */

import { describe, expect, it } from "bun:test";
import { defineRule } from "../src/define";
import {
  createActionExecutor,
  type DataProvider,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Helpers ────────────────────────────────────────────────────

const actor: Actor = { type: "human", id: "u1", groups: [] };

/**
 * Build a DataProvider backed by an in-memory map.
 * Records are stored under their `id` field.
 */
function makeProvider(seed: Record<string, Record<string, unknown>> = {}): DataProvider {
  const store = new Map(Object.entries(seed));
  return {
    async get(_schema: string, id: string) {
      const found = store.get(id);
      if (!found) throw new Error(`Record not found: ${id}`);
      return found;
    },
    async query() {
      return [];
    },
    async create(_schema: string, data: Record<string, unknown>) {
      const id = data.id as string;
      store.set(id, data);
      return data;
    },
    async update(_schema: string, id: string, data: Record<string, unknown>) {
      const existing = store.get(id) ?? { id };
      const updated = { ...existing, ...data };
      store.set(id, updated);
      return updated;
    },
    async delete(_schema: string, id: string) {
      store.delete(id);
    },
    async count() {
      return store.size;
    },
  };
}

/**
 * A TransactionManager whose txProvider deliberately has DIFFERENT record
 * state than the outer baseProvider. The txProvider is built from
 * `txSeedOverride` records; all other ops fall through to `baseProvider`.
 *
 * This simulates a concurrent commit: between the old (pre-fix) rule read
 * (against baseProvider, BEFORE the tx opens) and the write (inside the
 * tx), another transaction changes the record — so txProvider now reflects
 * the post-concurrent-commit state while baseProvider still has the stale
 * snapshot.
 */
function makeDivergedTxManager(
  baseProvider: DataProvider,
  txSeedOverride: Record<string, Record<string, unknown>>,
): TransactionManager {
  return {
    async runInTransaction<T>(
      fn: (tx: DataProvider) => Promise<T>,
      _pending: PendingEvent[],
    ): Promise<T> {
      // Build a txProvider that returns fresh (post-concurrent-commit) state
      // for seed records, delegating everything else to baseProvider.
      const freshStore = new Map(Object.entries(txSeedOverride));
      const txProvider: DataProvider = {
        ...baseProvider,
        async get(schema: string, id: string, opts?) {
          const fresh = freshStore.get(id);
          if (fresh) return fresh;
          return baseProvider.get(schema, id, opts);
        },
      };
      return fn(txProvider);
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("TOCTOU regression — rule reads record via txProvider inside transaction", () => {
  /**
   * Scenario:
   *   - baseProvider has order ord1 with status="open" (stale snapshot).
   *   - txProvider (from the TransactionManager) has ord1 with status="closed"
   *     (post-concurrent-commit state).
   *   - A block rule fires when status === "closed".
   *
   * With the TOCTOU fix:
   *   evaluateActionRules receives dp = txProvider → reads status="closed"
   *   → block fires → action is blocked.
   *
   * Without the fix (old behavior):
   *   evaluateActionRules received baseProvider → reads status="open"
   *   → block does not fire → action would proceed (incorrect).
   */
  it("block rule reads record from txProvider (fresh snapshot), not baseProvider (stale)", async () => {
    // base = stale snapshot (pre-concurrent-commit)
    const baseProvider = makeProvider({ ord1: { id: "ord1", status: "open" } });

    // tx = fresh snapshot (post-concurrent-commit: another tx closed the order)
    const txManager = makeDivergedTxManager(baseProvider, {
      ord1: { id: "ord1", status: "closed" },
    });

    const blockWhenClosed = defineRule({
      name: "block_when_closed",
      label: "Block when order is closed",
      trigger: { action: "update_order" },
      condition: { field: "target.status", operator: "eq", value: "closed" },
      effect: { type: "block", message: "Order is already closed", reason: "order_already_closed" },
    });

    let handlerRan = false;
    const updateOrderAction: ActionDefinition = {
      name: "update_order",
      entity: "order",
      input: { id: { type: "string", required: true } },
      policy: { transaction: true },
      handler: async () => {
        handlerRan = true;
        return {};
      },
    };

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: txManager,
      rules: [blockWhenClosed],
    });
    executor.registry.register(updateOrderAction);

    const result = await executor.execute("update_order", { id: "ord1" }, actor);

    // The block rule should have fired (read via txProvider → status="closed")
    expect(result.success).toBe(false);
    expect((result.data as { error?: string }).error).toContain("order_already_closed");
    // The handler must NOT have run (blocked before the write)
    expect(handlerRan).toBe(false);
  });

  /**
   * Complementary test: when baseProvider has status="closed" but txProvider
   * has status="open" (inverse scenario), the block rule should NOT fire —
   * because the tx-side state is "open". This proves the rule is reading from
   * txProvider in both directions, not from baseProvider.
   */
  it("block rule does NOT fire when txProvider shows open, even if baseProvider shows closed", async () => {
    // base = stale "closed" (would trigger the block if misread)
    const baseProvider = makeProvider({ ord2: { id: "ord2", status: "closed" } });

    // tx = fresh "open" (concurrent tx re-opened the order — contrived but valid
    // for isolating the provider-selection logic)
    const txManager = makeDivergedTxManager(baseProvider, {
      ord2: { id: "ord2", status: "open" },
    });

    const blockWhenClosed = defineRule({
      name: "block_when_closed",
      label: "Block when order is closed",
      trigger: { action: "update_order" },
      condition: { field: "target.status", operator: "eq", value: "closed" },
      effect: { type: "block", message: "Order is already closed", reason: "order_already_closed" },
    });

    let handlerRan = false;
    const updateOrderAction: ActionDefinition = {
      name: "update_order",
      entity: "order",
      input: { id: { type: "string", required: true } },
      policy: { transaction: true },
      handler: async () => {
        handlerRan = true;
        return {};
      },
    };

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: txManager,
      rules: [blockWhenClosed],
    });
    executor.registry.register(updateOrderAction);

    const result = await executor.execute("update_order", { id: "ord2" }, actor);

    // txProvider has status="open" → block rule does NOT fire → action succeeds
    expect(result.success).toBe(true);
    expect(handlerRan).toBe(true);
  });

  /**
   * Non-transactional actions (policy.transaction: false) continue to read
   * from baseProvider — there is no txProvider to pass. The fix must not
   * break this path.
   */
  it("non-transactional action: block rule reads from baseProvider (no tx, expected)", async () => {
    // baseProvider has status="closed" — block should fire
    const baseProvider = makeProvider({ ord3: { id: "ord3", status: "closed" } });
    // No TransactionManager — non-transactional path uses baseProvider directly

    const blockWhenClosed = defineRule({
      name: "block_when_closed",
      label: "Block when order is closed",
      trigger: { action: "update_order_no_tx" },
      condition: { field: "target.status", operator: "eq", value: "closed" },
      effect: { type: "block", message: "Order is already closed", reason: "order_already_closed" },
    });

    let handlerRan = false;
    const updateOrderNoTx: ActionDefinition = {
      name: "update_order_no_tx",
      entity: "order",
      input: { id: { type: "string", required: true } },
      policy: { transaction: false },
      handler: async () => {
        handlerRan = true;
        return {};
      },
    };

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      rules: [blockWhenClosed],
    });
    executor.registry.register(updateOrderNoTx);

    const result = await executor.execute("update_order_no_tx", { id: "ord3" }, actor);

    expect(result.success).toBe(false);
    expect((result.data as { error?: string }).error).toContain("order_already_closed");
    expect(handlerRan).toBe(false);
  });
});
