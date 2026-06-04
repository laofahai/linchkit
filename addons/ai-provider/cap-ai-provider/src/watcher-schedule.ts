/**
 * Watcher schedule (cron) tracking — Spec 45 §2.4
 *
 * Implements the `schedule` trigger for the WatcherEngine. Each scheduled
 * watcher owns a `croner` Cron instance used purely to *compute* the next run
 * time relative to a supplied reference date — the Cron is constructed without
 * a callback, so it never starts a real timer. The engine drives evaluation
 * from an injectable clock (`now()`), which keeps tests deterministic and
 * frees the scheduler from wall-clock flakiness.
 *
 * Verified croner@10.0.1 API (TS-native, zero runtime deps):
 * - `new Cron(pattern, { timezone })` — no callback ⇒ no scheduled job/timer.
 * - `cron.nextRun(prev?: Date | string | null): Date | null` — next run strictly
 *   after `prev` (strips milliseconds). Returns null when the pattern can never
 *   fire again.
 */

import { Cron } from "croner";

// ── Per-watcher schedule state ─────────────────────────────

export interface ScheduleState {
  /** Watcher name (1:1 with a registered schedule watcher) */
  watcherName: string;
  /** Cron instance used only to compute next-run times (no live timer) */
  cron: Cron;
  /**
   * The next scheduled fire time, or null if the cron can never fire again.
   * Computed strictly after the most recent reference point so each cron
   * occurrence is consumed exactly once.
   */
  nextDue: Date | null;
}

// ── Tracker ────────────────────────────────────────────────

/**
 * Tracks the next-due time for each scheduled watcher and reports which
 * watchers are due as the clock advances. Pure bookkeeping — it does not fire
 * effects itself; the engine consumes `collectDue()` results.
 */
export class ScheduleTracker {
  private states = new Map<string, ScheduleState>();

  /**
   * Register (or re-register) a scheduled watcher. Seeds `nextDue` to the first
   * cron occurrence strictly after `from`. Returns the created state, or null
   * if the cron expression is invalid.
   */
  register(args: {
    watcherName: string;
    cron: string;
    timezone?: string;
    from: Date;
  }): ScheduleState | null {
    const { watcherName, cron, timezone, from } = args;
    let cronInstance: Cron;
    try {
      // No callback ⇒ croner does not schedule a real timer (verified v10.0.1).
      cronInstance = timezone ? new Cron(cron, { timezone }) : new Cron(cron);
    } catch {
      return null;
    }

    const state: ScheduleState = {
      watcherName,
      cron: cronInstance,
      nextDue: cronInstance.nextRun(from),
    };
    this.states.set(watcherName, state);
    return state;
  }

  /** Remove a watcher's schedule state. */
  remove(watcherName: string): void {
    this.states.delete(watcherName);
  }

  /** Clear all tracked schedules. */
  clear(): void {
    this.states.clear();
  }

  /** Inspect a watcher's current schedule state (for testing/debugging). */
  get(watcherName: string): ScheduleState | undefined {
    return this.states.get(watcherName);
  }

  /**
   * Advance every tracked schedule up to `now` and return the watcher names
   * that became due, in chronological order, one entry per crossed occurrence.
   *
   * Due occurrences are collected with their fire time across ALL watchers, then
   * sorted ascending by that time, so effect ordering reflects when each
   * occurrence was due rather than the (arbitrary) watcher registration order.
   *
   * If the clock jumps past several occurrences between ticks (e.g. the process
   * was asleep, or a test fast-forwards the injected clock), each missed
   * occurrence is emitted once — never coalesced and never skipped — so the
   * effect fires the right number of times. A bounded guard prevents runaway
   * loops on pathologically large jumps.
   */
  collectDue(now: Date, maxOccurrencesPerWatcher = 1000): string[] {
    const due: Array<{ watcherName: string; dueAt: Date }> = [];

    for (const state of this.states.values()) {
      let guard = 0;
      while (
        state.nextDue !== null &&
        state.nextDue.getTime() <= now.getTime() &&
        guard < maxOccurrencesPerWatcher
      ) {
        due.push({ watcherName: state.watcherName, dueAt: state.nextDue });
        // Advance strictly past the consumed occurrence so the same tick is
        // never reported twice. croner's nextRun is exclusive of `prev`.
        state.nextDue = state.cron.nextRun(state.nextDue);
        guard += 1;
      }
    }

    due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    return due.map(({ watcherName }) => watcherName);
  }
}
