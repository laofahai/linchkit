/**
 * WatcherEngine — schedule (cron) trigger tests (Spec 45 §2.4).
 *
 * The engine is driven by an INJECTED clock so the scheduler is deterministic
 * and never time-flaky. Tests advance a mutable `now` and call
 * `engine.runScheduleTick()` directly (no real timers, no mocked engine/cron),
 * then assert on a FAKE WatcherActionExecutor's captured calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defineWatcher } from "@linchkit/core";
import { createWatcherRegistry, type WatcherRegistry } from "@linchkit/core/server";
import {
  createWatcherEngine,
  type WatcherActionExecutor,
  type WatcherDataQuerier,
  type WatcherEngine,
} from "../src/watcher-engine";

// ── Fakes ────────────────────────────────────────────────

function createFakeActionExecutor(): WatcherActionExecutor & {
  calls: Array<{ actionName: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ actionName: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async executeAction(actionName, input) {
      calls.push({ actionName, input });
      return { ok: true };
    },
  };
}

/** Mutable clock so tests can fast-forward deterministically. */
function createClock(start: Date): { now: () => Date; set: (d: Date) => void } {
  let current = start;
  return {
    now: () => current,
    set: (d: Date) => {
      current = d;
    },
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

// ── Tests ────────────────────────────────────────────────

describe("WatcherEngine — schedule (cron) triggers", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createFakeActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    actionExecutor = createFakeActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("seeds the next-due time to the first occurrence after start", () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        // Every day at 09:00 UTC.
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z")); // before 09:00
    engine = createWatcherEngine({
      registry,
      actionExecutor,
      clock: clock.now,
      scheduleIntervalMs: 60_000,
    });
    engine.start();

    expect(engine.getNextScheduledRun("daily-report")?.toISOString()).toBe(
      "2024-01-01T09:00:00.000Z",
    );
  });

  it("does not fire before the cron is due, fires exactly once when due", async () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: { kind: "daily" } },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    // 08:30 — not yet due.
    clock.set(at("2024-01-01T08:30:00.000Z"));
    const r1 = await engine.runScheduleTick();
    expect(r1).toHaveLength(0);
    expect(actionExecutor.calls).toHaveLength(0);

    // 09:00 — due exactly.
    clock.set(at("2024-01-01T09:00:00.000Z"));
    const r2 = await engine.runScheduleTick();
    expect(r2).toHaveLength(1);
    expect(r2[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("send_report");
    expect(actionExecutor.calls[0]?.input.kind).toBe("daily");

    // 09:30 same day — already consumed, next due is tomorrow 09:00.
    clock.set(at("2024-01-01T09:30:00.000Z"));
    const r3 = await engine.runScheduleTick();
    expect(r3).toHaveLength(0);
    expect(actionExecutor.calls).toHaveLength(1);
    expect(engine.getNextScheduledRun("daily-report")?.toISOString()).toBe(
      "2024-01-02T09:00:00.000Z",
    );
  });

  it("fires once per crossed occurrence when the clock jumps several days", async () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z")); // next due 01-01 09:00
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    // Jump to 01-04 10:00 — occurrences 01-01, 01-02, 01-03, 01-04 all due (4).
    clock.set(at("2024-01-04T10:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.fired)).toBe(true);
    expect(actionExecutor.calls).toHaveLength(4);
    // After consuming through 01-04, next due is 01-05 09:00.
    expect(engine.getNextScheduledRun("daily-report")?.toISOString()).toBe(
      "2024-01-05T09:00:00.000Z",
    );
  });

  it("fires on the weekly Monday-09:00 cron only on the right tick", async () => {
    registry.register(
      defineWatcher({
        name: "weekly-digest",
        watch: { entity: "purchase_request" },
        // 0 9 * * 1 = Mondays at 09:00 UTC.
        trigger: { type: "schedule", cron: "0 9 * * 1" },
        effect: { action: "send_digest", params: {} },
      }),
    );

    // 2024-01-07 is a Sunday; 2024-01-08 is a Monday.
    const clock = createClock(at("2024-01-07T00:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    expect(engine.getNextScheduledRun("weekly-digest")?.toISOString()).toBe(
      "2024-01-08T09:00:00.000Z",
    );

    // Tuesday — not yet due (Monday this week already passed for seed? no: seed was Mon 01-08).
    clock.set(at("2024-01-09T12:00:00.000Z"));
    await engine.runScheduleTick();
    expect(actionExecutor.calls).toHaveLength(1); // the 01-08 Monday occurrence
    expect(engine.getNextScheduledRun("weekly-digest")?.toISOString()).toBe(
      "2024-01-15T09:00:00.000Z",
    );

    // Advance to next Monday 09:00.
    clock.set(at("2024-01-15T09:00:00.000Z"));
    await engine.runScheduleTick();
    expect(actionExecutor.calls).toHaveLength(2);
  });

  // ── condition.count semantics (Spec 45 §2.4) ───────────

  it("fires only when the count condition is met", async () => {
    registry.register(
      defineWatcher({
        name: "weekly-unapproved",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.status", operator: "eq", value: "submitted" },
        },
        trigger: {
          type: "schedule",
          cron: "0 9 * * 1",
          condition: { count: { gt: 0 } },
        },
        effect: { action: "send_digest", params: {} },
      }),
    );

    // Querier returns 2 submitted + 1 approved → submitted count = 2 (> 0).
    const querier: WatcherDataQuerier = {
      async queryRecords() {
        return [
          { id: "pr-1", status: "submitted" },
          { id: "pr-2", status: "submitted" },
          { id: "pr-3", status: "approved" },
        ];
      },
    };

    const clock = createClock(at("2024-01-07T00:00:00.000Z")); // Sunday, seed Mon 01-08
    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: querier,
      clock: clock.now,
    });
    engine.start();

    clock.set(at("2024-01-08T09:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results).toHaveLength(1);
    expect(results[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
    // Context count/value reflects the filtered count.
    expect(actionExecutor.calls[0]?.input._watcher).toEqual({ name: "weekly-unapproved" });
  });

  it("does not fire when the count condition is not met", async () => {
    registry.register(
      defineWatcher({
        name: "weekly-unapproved",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.status", operator: "eq", value: "submitted" },
        },
        trigger: {
          type: "schedule",
          cron: "0 9 * * 1",
          condition: { count: { gt: 0 } },
        },
        effect: { action: "send_digest", params: {} },
      }),
    );

    // No submitted records → count = 0, condition (gt: 0) fails.
    const querier: WatcherDataQuerier = {
      async queryRecords() {
        return [
          { id: "pr-3", status: "approved" },
          { id: "pr-4", status: "draft" },
        ];
      },
    };

    const clock = createClock(at("2024-01-07T00:00:00.000Z"));
    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: querier,
      clock: clock.now,
    });
    engine.start();

    clock.set(at("2024-01-08T09:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results).toHaveLength(1);
    expect(results[0]?.fired).toBe(false);
    expect(results[0]?.reason).toBe("count_condition_not_met");
    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("reports missing dataQuerier when a count condition is declared", async () => {
    registry.register(
      defineWatcher({
        name: "weekly-unapproved",
        watch: { entity: "purchase_request" },
        trigger: {
          type: "schedule",
          cron: "0 9 * * 1",
          condition: { count: { gt: 0 } },
        },
        effect: { action: "send_digest", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-07T00:00:00.000Z"));
    // No dataQuerier provided.
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    clock.set(at("2024-01-08T09:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results[0]?.fired).toBe(false);
    expect(results[0]?.reason).toBe("no_data_querier_for_count_condition");
    expect(actionExecutor.calls).toHaveLength(0);
  });

  // ── Debounce + lifecycle ───────────────────────────────

  it("honors cooldown debounce across due occurrences", async () => {
    registry.register(
      defineWatcher({
        name: "hourly-cooldown",
        watch: { entity: "purchase_request" },
        // Every hour at minute 0.
        trigger: {
          type: "schedule",
          cron: "0 * * * *",
          debounce: "cooldown",
          cooldownPeriod: "90m",
        },
        effect: { action: "ping", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T00:30:00.000Z")); // next due 01:00
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    // 01:00 — fires (no prior fire).
    clock.set(at("2024-01-01T01:00:00.000Z"));
    await engine.runScheduleTick();
    expect(actionExecutor.calls).toHaveLength(1);

    // 02:00 — only 60m since last fire (< 90m cooldown) → debounced.
    clock.set(at("2024-01-01T02:00:00.000Z"));
    const r2 = await engine.runScheduleTick();
    expect(r2[0]?.fired).toBe(false);
    expect(r2[0]?.reason).toBe("debounced");
    expect(actionExecutor.calls).toHaveLength(1);

    // 03:00 — 120m since last fire (≥ 90m) → fires again.
    clock.set(at("2024-01-01T03:00:00.000Z"));
    await engine.runScheduleTick();
    expect(actionExecutor.calls).toHaveLength(2);
  });

  it("does not fire after the watcher is disabled", async () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    registry.disable("daily-report");

    clock.set(at("2024-01-01T09:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results[0]?.fired).toBe(false);
    expect(results[0]?.reason).toBe("watcher_unavailable");
    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("ignores an invalid cron expression and keeps other schedules running", async () => {
    registry.register(
      defineWatcher({
        name: "broken",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "not-a-cron" },
        effect: { action: "noop", params: {} },
      }),
    );
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({
      registry,
      actionExecutor,
      clock: clock.now,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    engine.start();

    // Invalid cron was not tracked.
    expect(engine.getNextScheduledRun("broken")).toBeUndefined();
    // Valid one still scheduled.
    expect(engine.getNextScheduledRun("daily-report")?.toISOString()).toBe(
      "2024-01-01T09:00:00.000Z",
    );

    clock.set(at("2024-01-01T09:00:00.000Z"));
    await engine.runScheduleTick();
    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("send_report");
  });

  it("drops a disabled watcher from the tracker after a tick (Finding 2)", async () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    // Tracked after start.
    expect(engine.getNextScheduledRun("daily-report")).toBeDefined();

    // Disable, then advance past the due time and tick.
    registry.disable("daily-report");
    clock.set(at("2024-01-01T09:00:00.000Z"));
    const results = await engine.runScheduleTick();

    expect(results[0]?.reason).toBe("watcher_unavailable");
    // No longer tracked: the engine stops computing next-run times for it.
    expect(engine.getNextScheduledRun("daily-report")).toBeUndefined();

    // A subsequent tick the next day produces nothing (the schedule is gone).
    clock.set(at("2024-01-02T09:00:00.000Z"));
    const results2 = await engine.runScheduleTick();
    expect(results2).toHaveLength(0);
    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("re-fires an once_until_reset watcher after its count drops then rises (Finding 1)", async () => {
    registry.register(
      defineWatcher({
        name: "hourly-unapproved",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.status", operator: "eq", value: "submitted" },
        },
        trigger: {
          type: "schedule",
          // Every hour at minute 0 so we get multiple due occurrences.
          cron: "0 * * * *",
          condition: { count: { gt: 0 } },
          debounce: "once_until_reset",
        },
        effect: { action: "send_digest", params: {} },
      }),
    );

    // Mutable submitted-record count driving the querier across ticks.
    let submittedCount = 1;
    const querier: WatcherDataQuerier = {
      async queryRecords() {
        const records: Array<Record<string, unknown>> = [];
        for (let i = 0; i < submittedCount; i += 1) {
          records.push({ id: `pr-${i}`, status: "submitted" });
        }
        return records;
      },
    };

    const clock = createClock(at("2024-01-01T00:30:00.000Z")); // next due 01:00
    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: querier,
      clock: clock.now,
    });
    engine.start();

    // 01:00 — count = 1 (> 0), first transition false→true → fires.
    clock.set(at("2024-01-01T01:00:00.000Z"));
    const r1 = await engine.runScheduleTick();
    expect(r1[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);

    // 02:00 — still 1, condition still met, once_until_reset suppresses → debounced.
    clock.set(at("2024-01-01T02:00:00.000Z"));
    const r2 = await engine.runScheduleTick();
    expect(r2[0]?.fired).toBe(false);
    expect(r2[0]?.reason).toBe("debounced");
    expect(actionExecutor.calls).toHaveLength(1);

    // 03:00 — count drops to 0, condition NOT met → resets debounce state to false.
    submittedCount = 0;
    clock.set(at("2024-01-01T03:00:00.000Z"));
    const r3 = await engine.runScheduleTick();
    expect(r3[0]?.fired).toBe(false);
    expect(r3[0]?.reason).toBe("count_condition_not_met");
    expect(actionExecutor.calls).toHaveLength(1);

    // 04:00 — count rises back to 2, condition met again. Because the state was
    // reset at 03:00, once_until_reset allows a fresh false→true fire.
    submittedCount = 2;
    clock.set(at("2024-01-01T04:00:00.000Z"));
    const r4 = await engine.runScheduleTick();
    expect(r4[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(2);
  });

  it("fires each due occurrence only once when ticks overlap with a slow effect (Finding 4)", async () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    // A slow action executor that resolves only when we release it, letting two
    // runScheduleTick() calls overlap deterministically (no real timers).
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const slowExecutor: WatcherActionExecutor = {
      async executeAction(actionName) {
        calls.push(actionName);
        await gate;
        return { ok: true };
      },
    };

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor: slowExecutor, clock: clock.now });
    engine.start();

    // 09:00 — due. Start the first tick (awaiting the slow effect) WITHOUT
    // awaiting it, then start a second overlapping tick before the first resolves.
    clock.set(at("2024-01-01T09:00:00.000Z"));
    const tick1 = engine.runScheduleTick();
    const tick2 = engine.runScheduleTick();

    // The second call coalesces onto the in-flight pass — it must be the same
    // promise, not a fresh pass that re-consumes the same due occurrence.
    expect(tick2).toBe(tick1);

    release();
    const [r1, r2] = await Promise.all([tick1, tick2]);

    // The effect ran exactly once for the single due occurrence.
    expect(calls).toHaveLength(1);
    expect(r1).toEqual(r2);
    expect(r1.filter((r) => r.fired)).toHaveLength(1);
  });

  it("returns due occurrences sorted by due time across iteration order (Finding 5)", async () => {
    // Register the LATER-due watcher first so Map iteration order (insertion)
    // differs from chronological order; the engine must still emit chronologically.
    registry.register(
      defineWatcher({
        name: "later-10am",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 10 * * *" }, // due 10:00
        effect: { action: "later_effect", params: {} },
      }),
    );
    registry.register(
      defineWatcher({
        name: "earlier-9am",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" }, // due 09:00
        effect: { action: "earlier_effect", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();

    // Advance past BOTH due times in a single tick.
    clock.set(at("2024-01-01T11:00:00.000Z"));
    const results = await engine.runScheduleTick();

    // Both fired, ordered by due time (09:00 before 10:00) — not registration order.
    expect(results.map((r) => r.watcherName)).toEqual(["earlier-9am", "later-10am"]);
    expect(actionExecutor.calls.map((c) => c.actionName)).toEqual([
      "earlier_effect",
      "later_effect",
    ]);
  });

  it("clears schedule state on stop", () => {
    registry.register(
      defineWatcher({
        name: "daily-report",
        watch: { entity: "purchase_request" },
        trigger: { type: "schedule", cron: "0 9 * * *" },
        effect: { action: "send_report", params: {} },
      }),
    );

    const clock = createClock(at("2024-01-01T08:00:00.000Z"));
    engine = createWatcherEngine({ registry, actionExecutor, clock: clock.now });
    engine.start();
    expect(engine.getNextScheduledRun("daily-report")).toBeDefined();

    engine.stop();
    expect(engine.getNextScheduledRun("daily-report")).toBeUndefined();
  });
});
