/**
 * Watcher schedule subsystem (Spec 45 §2.4).
 *
 * Extracted from `watcher-engine.ts` to keep both files under the repo's
 * 500-line ceiling. Owns the cron scheduler bootstrap (interval management) and
 * the schedule-watcher evaluation logic, delegating debounce/effect concerns
 * back to the host engine through explicitly injected collaborators so the two
 * modules stay loosely coupled (no circular state ownership).
 *
 * The scheduler is driven by an injectable clock; tests advance the clock and
 * call `runTick()` directly without real timers.
 */

import type {
  Logger,
  WatcherContext,
  WatcherDefinition,
  WatcherEvaluationResult,
} from "@linchkit/core";
import { evaluateCondition } from "@linchkit/core";
import type { WatcherRegistry } from "@linchkit/core/server";
import { ScheduleTracker } from "./watcher-schedule";

// ── Collaborators injected by the host WatcherEngine ──────

export interface ScheduleEngineDeps {
  registry: WatcherRegistry;
  /** Data querier used to evaluate `condition.count` (queries matching records). */
  dataQuerier?: {
    queryRecords(
      schema: string,
      filter?: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
  };
  logger: Logger;
  /** Injectable clock — drives the scheduler deterministically. */
  clock: () => Date;
  /** Schedule (cron) tick interval in ms. */
  scheduleIntervalMs: number;
  /** Numeric comparison evaluator (shared with the engine). */
  evaluateComparison: (
    value: number,
    condition: { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number },
  ) => boolean;
  /** Debounce gate — returns true when the watcher should fire for this group. */
  shouldFire: (watcher: WatcherDefinition, groupKey: string, conditionMet: boolean) => boolean;
  /** Execute the watcher's effect through the action pipeline. */
  fireEffect: (watcher: WatcherDefinition, ctx: WatcherContext) => Promise<void>;
  /** Record debounce state after evaluating a watcher occurrence. */
  updateState: (watcherName: string, groupKey: string, conditionMet: boolean) => void;
}

// ── Schedule subsystem ────────────────────────────────────

/**
 * Manages cron-scheduled watchers: seeds next-due times, runs ticks (with
 * serialized, non-overlapping execution), and evaluates each due occurrence.
 */
export class ScheduleEngine {
  private readonly deps: ScheduleEngineDeps;
  private readonly tracker = new ScheduleTracker();
  private interval?: ReturnType<typeof setInterval>;

  /**
   * In-flight tick promise. While set, a concurrent `runTick()` awaits the same
   * pass instead of starting a fresh one — so a slow `fireEffect` can never let
   * the next interval tick fire the same due occurrence twice before debounce
   * state has been written.
   */
  private tickInFlight?: Promise<WatcherEvaluationResult[]>;

  constructor(deps: ScheduleEngineDeps) {
    this.deps = deps;
  }

  /** Group key under which schedule debounce state is stored. */
  private static readonly GROUP_KEY = "schedule";

  /**
   * Seed next-due times for all enabled schedule watchers and start the tick
   * interval. No-op when there are no (valid) schedule watchers.
   */
  start(): void {
    const scheduleWatchers = this.deps.registry
      .getEnabled()
      .filter((w) => w.trigger.type === "schedule");

    if (scheduleWatchers.length === 0) return;

    // Seed the next-due time for each schedule watcher from the current clock.
    const now = this.deps.clock();
    let registered = 0;
    for (const watcher of scheduleWatchers) {
      const trigger = watcher.trigger;
      if (trigger.type !== "schedule") continue;

      const state = this.tracker.register({
        watcherName: watcher.name,
        cron: trigger.cron,
        // Interpret cron expressions in UTC for deterministic, region-stable
        // server-side scheduling (independent of the host's local timezone).
        timezone: "UTC",
        from: now,
      });

      if (state) {
        registered += 1;
      } else {
        this.deps.logger.warn?.(
          `[WatcherEngine] Invalid cron "${trigger.cron}" for schedule watcher "${watcher.name}"`,
        );
      }
    }

    // All cron expressions failed to register — nothing to poll.
    if (registered === 0) return;

    this.interval = setInterval(() => {
      void this.runTick();
    }, this.deps.scheduleIntervalMs);
  }

  /** Stop the tick interval and clear all tracked schedules. */
  stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.tracker.clear();
  }

  /** A scheduled watcher's next-due time (for testing/debugging). */
  getNextScheduledRun(watcherName: string): Date | null | undefined {
    return this.tracker.get(watcherName)?.nextDue;
  }

  /**
   * Evaluate all schedule watchers whose cron occurrence is due at the current
   * clock time. Serialized: a concurrent call returns the in-flight pass.
   */
  runTick(): Promise<WatcherEvaluationResult[]> {
    // Coalesce concurrent callers onto a single in-flight pass so a slow
    // fireEffect can never let the next tick re-consume the same due occurrence
    // before debounce state has been written. The stored promise IS the one
    // returned to every caller, and it self-clears once it settles.
    const inFlight = this.tickInFlight;
    if (inFlight) return inFlight;

    const pass = (async () => {
      try {
        return await this.runTickInternal();
      } finally {
        this.tickInFlight = undefined;
      }
    })();
    this.tickInFlight = pass;
    return pass;
  }

  private async runTickInternal(): Promise<WatcherEvaluationResult[]> {
    const now = this.deps.clock();
    const dueWatcherNames = this.tracker.collectDue(now);
    const results: WatcherEvaluationResult[] = [];

    for (const watcherName of dueWatcherNames) {
      // Re-check enabled status on every occurrence — a watcher may have been
      // disabled or removed since the schedule was registered.
      const watcher = this.deps.registry.get(watcherName);
      if (!watcher?.enabled || watcher.trigger.type !== "schedule") {
        results.push({ watcherName, fired: false, reason: "watcher_unavailable" });
        // Drop the orphaned schedule so we stop computing next-run times for a
        // watcher that no longer exists / is disabled (CPU + memory leak).
        this.tracker.remove(watcherName);
        continue;
      }

      try {
        results.push(await this.evaluate(watcher));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.deps.logger.error?.(
          `[WatcherEngine] Schedule tick error for "${watcherName}": ${error}`,
        );
        results.push({ watcherName, fired: false, error });
      }
    }

    return results;
  }

  /**
   * Evaluate one due occurrence of a schedule watcher. When the trigger carries
   * a `condition.count`, the matching record count is compared against it and
   * the effect only fires if the comparison holds. Without a condition, the
   * effect fires on each due tick (Spec 45 §2.4).
   */
  private async evaluate(watcher: WatcherDefinition): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;
    if (trigger.type !== "schedule") {
      return { watcherName: watcher.name, fired: false, reason: "wrong_trigger_type" };
    }

    const groupKey = ScheduleEngine.GROUP_KEY;
    const ctx: WatcherContext = { watcherName: watcher.name };

    // Optional count condition: evaluate the matching-record count.
    const countCondition = trigger.condition?.count;
    if (countCondition) {
      if (!this.deps.dataQuerier) {
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "no_data_querier_for_count_condition",
        };
      }

      const records = await this.deps.dataQuerier.queryRecords(watcher.watch.entity);
      const watchFilter = watcher.watch.filter;
      const matching = watchFilter
        ? records.filter((r) =>
            evaluateCondition(watchFilter, {
              target: r,
              context: {},
              actor: { type: "system", id: "watcher", groups: [] },
            }),
          )
        : records;

      const count = matching.length;
      if (!this.deps.evaluateComparison(count, countCondition)) {
        // Reset debounce state so a `once_until_reset` watcher can fire again
        // once the count later rises back above the threshold. Without this the
        // prior `conditionMet: true` would permanently suppress future fires.
        this.deps.updateState(watcher.name, groupKey, false);
        return { watcherName: watcher.name, fired: false, reason: "count_condition_not_met" };
      }

      ctx.records = matching;
      ctx.count = count;
      ctx.value = count;
    }

    // Schedule watchers fire per due occurrence; cron itself is the debounce.
    if (!this.deps.shouldFire(watcher, groupKey, true)) {
      return { watcherName: watcher.name, fired: false, reason: "debounced" };
    }

    await this.deps.fireEffect(watcher, ctx);
    this.deps.updateState(watcher.name, groupKey, true);

    return { watcherName: watcher.name, fired: true };
  }
}
