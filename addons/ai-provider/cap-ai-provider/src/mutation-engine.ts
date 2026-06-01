/**
 * Watcher reactive + staleness evaluation subsystem (Spec 45).
 *
 * Extracted from `watcher-engine.ts` to keep that file under the repo's
 * 500-line ceiling. Owns:
 * - post-mutation reactive evaluation (`threshold`, `set_change`)
 * - the staleness polling loop (timer + per-record age check)
 * - aggregate computation and per-watcher group-key derivation
 *
 * Debounce/effect concerns are delegated back to the host engine through
 * explicitly injected collaborators so this module never owns the shared
 * debounce state map directly.
 */

import type {
  Logger,
  WatcherAggregateConfig,
  WatcherContext,
  WatcherDefinition,
  WatcherEvaluationResult,
} from "@linchkit/core";
import { type ConditionContext, evaluateCondition } from "@linchkit/core";
import type { WatcherRegistry } from "@linchkit/core/server";

// ── Collaborators injected by the host WatcherEngine ──────

export interface MutationEngineDeps {
  registry: WatcherRegistry;
  /** Data querier for aggregate + staleness checks (queries matching records). */
  dataQuerier?: {
    queryRecords(
      schema: string,
      filter?: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
  };
  logger: Logger;
  /** Staleness check interval in ms. */
  stalenessIntervalMs: number;
  /** Numeric comparison evaluator (shared with the engine). */
  evaluateComparison: (
    value: number,
    condition: { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number },
  ) => boolean;
  /** Parse a duration string (e.g. "48h") to milliseconds, or null. */
  parseDuration: (duration: string) => number | null;
  /** Debounce gate — returns true when the watcher should fire for this group. */
  shouldFire: (watcher: WatcherDefinition, groupKey: string, conditionMet: boolean) => boolean;
  /** Execute the watcher's effect through the action pipeline. */
  fireEffect: (watcher: WatcherDefinition, ctx: WatcherContext) => Promise<void>;
  /** Record debounce state after evaluating a watcher occurrence. */
  updateState: (watcherName: string, groupKey: string, conditionMet: boolean) => void;
  /**
   * Clear the `conditionMet` flag for a group so a `once_until_reset` watcher
   * can fire again once the condition re-occurs. No-op when no state exists.
   */
  resetConditionMet: (watcherName: string, groupKey: string) => void;
}

/** A watcher's declarative record filter (inferred from the core type). */
type WatcherFilter = NonNullable<WatcherDefinition["watch"]["filter"]>;

function systemActor(): { type: string; id: string; groups: string[] } {
  return { type: "system", id: "watcher", groups: [] };
}

function matchesFilter(filter: WatcherFilter, target: Record<string, unknown>): boolean {
  const ctx: ConditionContext = { target, context: {}, actor: systemActor() };
  return evaluateCondition(filter, ctx);
}

// ── Subsystem ─────────────────────────────────────────────

/**
 * Evaluates the non-schedule watcher triggers: reactive (`threshold`,
 * `set_change`) and the polled `staleness` trigger.
 */
export class MutationEngine {
  private readonly deps: MutationEngineDeps;
  private stalenessInterval?: ReturnType<typeof setInterval>;

  constructor(deps: MutationEngineDeps) {
    this.deps = deps;
  }

  /** Start the staleness polling loop. No-op without staleness watchers. */
  start(): void {
    const stalenessWatchers = this.deps.registry
      .getEnabled()
      .filter((w) => w.trigger.type === "staleness");

    if (stalenessWatchers.length === 0) return;
    if (!this.deps.dataQuerier) {
      this.deps.logger.warn?.(
        "[WatcherEngine] Staleness watchers registered but no dataQuerier provided",
      );
      return;
    }

    this.stalenessInterval = setInterval(async () => {
      for (const watcher of stalenessWatchers) {
        // Re-check enabled status
        const current = this.deps.registry.get(watcher.name);
        if (!current?.enabled) continue;

        try {
          await this.evaluateStaleness(current);
        } catch (err) {
          this.deps.logger.error?.(
            `[WatcherEngine] Staleness check error for "${watcher.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }, this.deps.stalenessIntervalMs);
  }

  /** Stop the staleness polling loop. */
  stop(): void {
    if (this.stalenessInterval !== undefined) {
      clearInterval(this.stalenessInterval);
      this.stalenessInterval = undefined;
    }
  }

  // ── Post-mutation reactive evaluation ───────────────────

  /**
   * Evaluate one watcher against a mutated record. `threshold` and `set_change`
   * are handled here; `staleness` and `schedule` are polled, not reactive.
   */
  async evaluate(
    watcher: WatcherDefinition,
    record: Record<string, unknown>,
    oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;

    // For set_change watchers, the filter is evaluated internally
    // (old vs new against filter). For other types, apply filter as a pre-check.
    if (trigger.type !== "set_change" && watcher.watch.filter) {
      if (!matchesFilter(watcher.watch.filter, record)) {
        return { watcherName: watcher.name, fired: false, reason: "filter_not_matched" };
      }
    }

    switch (trigger.type) {
      case "threshold":
        return this.evaluateThreshold(watcher, record);

      case "set_change":
        return this.evaluateSetChange(watcher, record, oldRecord);

      default:
        // staleness and schedule are handled by polling, not post-mutation
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "trigger_type_not_reactive",
        };
    }
  }

  // ── Threshold evaluation ────────────────────────────────

  private async evaluateThreshold(
    watcher: WatcherDefinition,
    record: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;
    if (trigger.type !== "threshold") {
      return { watcherName: watcher.name, fired: false, reason: "wrong_trigger_type" };
    }

    // Determine the value to compare
    let currentValue: number;

    if (watcher.watch.aggregate) {
      // Aggregate watchers need a data querier to compute aggregates
      if (!this.deps.dataQuerier) {
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "no_data_querier_for_aggregate",
        };
      }

      const records = await this.deps.dataQuerier.queryRecords(watcher.watch.entity);
      // Apply filter in-memory if present
      const watchFilter = watcher.watch.filter;
      const filtered = watchFilter ? records.filter((r) => matchesFilter(watchFilter, r)) : records;

      currentValue = this.computeAggregate(filtered, watcher.watch.aggregate);
    } else {
      // Single-record: read the field value directly
      const fieldName = trigger.field;
      if (!fieldName) {
        return { watcherName: watcher.name, fired: false, reason: "no_field_specified" };
      }
      const rawValue = record[fieldName];
      if (typeof rawValue !== "number") {
        return { watcherName: watcher.name, fired: false, reason: "field_not_numeric" };
      }
      currentValue = rawValue;
    }

    const conditionMet = this.deps.evaluateComparison(currentValue, trigger.condition);
    const groupKey = this.getGroupKey(watcher, record);

    // Debounce check
    if (!this.deps.shouldFire(watcher, groupKey, conditionMet)) {
      return { watcherName: watcher.name, fired: false, reason: "debounced" };
    }

    // Fire the effect
    const ctx: WatcherContext = {
      record,
      value: currentValue,
      watcherName: watcher.name,
    };

    await this.deps.fireEffect(watcher, ctx);

    // Update state
    this.deps.updateState(watcher.name, groupKey, conditionMet);

    return { watcherName: watcher.name, fired: true };
  }

  // ── Set-change evaluation ───────────────────────────────

  private async evaluateSetChange(
    watcher: WatcherDefinition,
    record: Record<string, unknown>,
    oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;
    if (trigger.type !== "set_change") {
      return { watcherName: watcher.name, fired: false, reason: "wrong_trigger_type" };
    }

    const filter = watcher.watch.filter;
    if (!filter) {
      return { watcherName: watcher.name, fired: false, reason: "set_change_requires_filter" };
    }

    const newMatchesFilter = matchesFilter(filter, record);
    const oldMatchesFilter = oldRecord ? matchesFilter(filter, oldRecord) : false;

    let shouldTrigger = false;

    switch (trigger.on) {
      case "added":
        // Record entered the set (was not in set, now is)
        shouldTrigger = !oldMatchesFilter && newMatchesFilter;
        break;
      case "removed":
        // Record left the set (was in set, now is not)
        shouldTrigger = oldMatchesFilter && !newMatchesFilter;
        break;
      case "modified":
        // Record was in set and still is, but data changed
        shouldTrigger = oldMatchesFilter && newMatchesFilter && oldRecord !== undefined;
        break;
    }

    if (!shouldTrigger) {
      return { watcherName: watcher.name, fired: false, reason: "set_change_not_detected" };
    }

    const groupKey = this.getGroupKey(watcher, record);

    if (!this.deps.shouldFire(watcher, groupKey, true)) {
      return { watcherName: watcher.name, fired: false, reason: "debounced" };
    }

    const ctx: WatcherContext = { record, watcherName: watcher.name };

    await this.deps.fireEffect(watcher, ctx);
    this.deps.updateState(watcher.name, groupKey, true);

    return { watcherName: watcher.name, fired: true };
  }

  // ── Staleness evaluation ────────────────────────────────

  private async evaluateStaleness(watcher: WatcherDefinition): Promise<void> {
    const trigger = watcher.trigger;
    if (trigger.type !== "staleness" || !this.deps.dataQuerier) return;

    const thresholdMs = this.deps.parseDuration(trigger.threshold);
    if (thresholdMs === null) {
      this.deps.logger.warn?.(
        `[WatcherEngine] Cannot parse staleness threshold "${trigger.threshold}" for watcher "${watcher.name}"`,
      );
      return;
    }

    const records = await this.deps.dataQuerier.queryRecords(watcher.watch.entity);

    // Apply filter
    const watchFilter = watcher.watch.filter;
    const filtered = watchFilter ? records.filter((r) => matchesFilter(watchFilter, r)) : records;

    const now = Date.now();

    for (const record of filtered) {
      const fieldValue = record[trigger.field];
      if (!fieldValue) continue;

      const timestamp =
        fieldValue instanceof Date
          ? fieldValue.getTime()
          : new Date(fieldValue as string).getTime();

      if (Number.isNaN(timestamp)) continue;

      const age = now - timestamp;
      const isStale = age > thresholdMs;

      const groupKey = String(record.id ?? JSON.stringify(record));

      if (!isStale) {
        // Condition no longer met — reset state so it can fire again later.
        this.deps.resetConditionMet(watcher.name, groupKey);
        continue;
      }

      if (!this.deps.shouldFire(watcher, groupKey, true)) {
        continue;
      }

      const ctx: WatcherContext = { record, watcherName: watcher.name };

      await this.deps.fireEffect(watcher, ctx);
      this.deps.updateState(watcher.name, groupKey, true);
    }
  }

  // ── Aggregate computation ───────────────────────────────

  private computeAggregate(
    records: Array<Record<string, unknown>>,
    config: WatcherAggregateConfig,
  ): number {
    const values = records
      .map((r) => r[config.field])
      .filter((v): v is number => typeof v === "number");

    switch (config.op) {
      case "sum":
        return values.reduce((acc, v) => acc + v, 0);
      case "count":
        return values.length;
      case "avg":
        return values.length > 0 ? values.reduce((acc, v) => acc + v, 0) / values.length : 0;
      case "min":
        return values.length > 0 ? Math.min(...values) : 0;
      case "max":
        return values.length > 0 ? Math.max(...values) : 0;
      default:
        return 0;
    }
  }

  // ── Group key ───────────────────────────────────────────

  private getGroupKey(watcher: WatcherDefinition, record: Record<string, unknown>): string {
    if (watcher.watch.aggregate?.groupBy) {
      return String(record[watcher.watch.aggregate.groupBy] ?? "default");
    }
    // Use record ID as group key for per-record watchers
    return String(record.id ?? "default");
  }
}
