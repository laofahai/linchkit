/**
 * Record-state rules are evaluated inside the write transaction (#462 / #466).
 *
 * For a TOP-LEVEL transactional action, a record-state `block` /
 * `require_approval` rule must read the record through the SAME database
 * snapshot the write uses — i.e. inside `runInTransaction` — so a concurrent
 * commit landing between the rule read and the write can't flip the guard
 * decision (a TOCTOU window). This mirrors the in-tx relocation field-lock
 * enforcement took in #203.
 *
 * The test models the race with two provider snapshots: the executor's base
 * (pre-transaction) provider returns a STALE row; the transactional provider
 * returns the FRESH row. The rule must decide on the FRESH (in-tx) snapshot.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type PendingEvent,
  type TransactionManager,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";

const actor: Actor = { type: "human", id: "u1", groups: [] };

interface Cap {
  updated: boolean;
}

/** Provider that always reads `record` and records whether `update` ran. */
function makeProvider(record: Record<string, unknown>, cap: Cap): DataProvider {
  return {
    get: async (_entity, id) => ({ id, ...record }),
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
    trigger: { action: "approve_thing" },
    condition: { field: "target.status", operator: "eq", value: "approved" },
    effect: { type: "block", message: "Already approved", reason: "already_approved" },
  };
}

/** Transactional update action — writes via ctx.update so a write is detectable. */
function approveAction(): ActionDefinition {
  return {
    name: "approve_thing",
    entity: "thing",
    label: "Approve",
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const input = ctx.input as { id: string };
      return ctx.update("thing", input.id, { status: "done" });
    },
  };
}

describe("record-state rules read inside the write transaction (#462 / #466 TOCTOU)", () => {
  it("a record-state block fires on the IN-TX snapshot (fresh), not the pre-tx base snapshot (stale)", async () => {
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    // Base (pre-tx) reads STALE "pending" → an old pre-tx read would NOT block.
    const baseProvider = makeProvider({ status: "pending" }, baseCap);
    // The transaction sees FRESH "approved" → the rule must block on THIS snapshot.
    const txProvider = makeProvider({ status: "approved" }, txCap);

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [blockIfApproved()],
    });
    executor.registry.register(approveAction());

    const result = await executor.execute("approve_thing", { id: "r1" }, actor);

    // Blocked on the fresh in-tx snapshot — FAILS if the rule still reads pre-tx.
    expect(result.success).toBe(false);
    expect((result.data as { context?: { constraint?: string } }).context?.constraint).toBe(
      "rule_block",
    );
    // No write happened on either provider.
    expect(baseCap.updated).toBe(false);
    expect(txCap.updated).toBe(false);
  });

  it("enrich cannot mask the fresh record state in the in-tx re-check (codex R1 regression)", async () => {
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    // Pre-tx base reads a non-approved row → Step 4c proceeds past the guard.
    const baseProvider = makeProvider({ status: "draft" }, baseCap);
    // The transaction sees the row as already approved.
    const txProvider = makeProvider({ status: "approved" }, txCap);
    // An enrich rule sets the SAME field the guard inspects. The in-tx re-check
    // must evaluate against the pre-enrich input so this enriched `status` does
    // NOT mask the fresh record's "approved" state.
    const enrichStatus: RuleDefinition = {
      name: "enrich_status_pending",
      label: "Enrich status",
      trigger: { action: "approve_thing" },
      condition: { field: "target.id", operator: "eq", value: "r1" },
      effect: { type: "enrich", setFields: { status: "pending" } },
    };

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [enrichStatus, blockIfApproved()],
    });
    executor.registry.register(approveAction());

    const result = await executor.execute("approve_thing", { id: "r1" }, actor);

    expect(result.success).toBe(false);
    expect((result.data as { context?: { constraint?: string } }).context?.constraint).toBe(
      "rule_block",
    );
    expect(txCap.updated).toBe(false);
  });

  it("control: when the in-tx snapshot is NOT approved, the rule does not fire and the write proceeds", async () => {
    const baseCap: Cap = { updated: false };
    const txCap: Cap = { updated: false };
    const baseProvider = makeProvider({ status: "pending" }, baseCap);
    const txProvider = makeProvider({ status: "pending" }, txCap);

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      transactionManager: makeTxManager(txProvider),
      rules: [blockIfApproved()],
    });
    executor.registry.register(approveAction());

    const result = await executor.execute("approve_thing", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    // The write went through the transactional provider, not the base one.
    expect(txCap.updated).toBe(true);
    expect(baseCap.updated).toBe(false);
  });
});
