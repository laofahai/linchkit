/**
 * Watcher Engine
 *
 * Evaluates data-condition watchers (spec 45).
 * Two evaluation modes:
 * - Post-mutation (reactive): threshold and set_change watchers evaluated after actions
 * - Timer-based (polling): staleness watchers evaluated on interval
 *
 * Watcher effects execute through normal action pipeline (CommandLayer).
 *
 * Implements the abstract `Watcher` lifecycle contract from `@linchkit/core`
 * (Spec 56 Phase 2 Step 2c). The concrete impl was moved out of core into
 * this capability so core retains only the interface.
 */

import type {
  EventBusLike,
  EventRecord,
  Logger,
  Watcher,
  WatcherComparisonCondition,
  WatcherContext,
  WatcherDefinition,
  WatcherEvaluationResult,
  WatcherStateEntry,
} from "@linchkit/core";
import { type ConditionContext, evaluateCondition } from "@linchkit/core";
import type { WatcherRegistry } from "@linchkit/core/server";

// ── Action executor interface (shared with watcher effects) ──

export interface WatcherActionExecutor {
  /** Execute a named action with given input. Returns action result. */
  executeAction(actionName: string, input: Record<string, unknown>): Promise<unknown>;
}

// ── Data query interface (avoids coupling to DataProvider) ──

export interface WatcherDataQuerier {
  /** Query records matching a schema, returning filtered results */
  queryRecords(
    schema: string,
    filter?: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
}

// ── Watcher Engine interface ──────────────────────────────

/**
 * WatcherEngine extends the abstract `Watcher` lifecycle contract with the
 * data-condition-specific evaluation API needed by the action pipeline.
 *
 * `start()` / `stop()` come from `Watcher`; the additional methods cover the
 * post-mutation reactive path and debounce-state inspection.
 */
export interface WatcherEngine extends Watcher {
  /**
   * Evaluate watchers for a specific schema after a mutation.
   * Called by the mutation pipeline (post-action).
   * Returns evaluation results for all matched watchers.
   */
  evaluateAfterMutation(
    entityName: string,
    record: Record<string, unknown>,
    oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult[]>;

  /** Get the current debounce state for a watcher (for testing/debugging) */
  getState(watcherName: string, groupKey: string): WatcherStateEntry | undefined;

  /** Reset debounce state for a watcher (for testing) */
  resetState(watcherName: string, groupKey?: string): void;
}

// ── Options ───────────────────────────────────────────────

export interface WatcherEngineOptions {
  registry: WatcherRegistry;
  /** Event bus — subscribe to record.created / record.updated for reactive evaluation */
  eventBus?: EventBusLike;
  /** Action executor for running watcher effects */
  actionExecutor?: WatcherActionExecutor;
  /** Data querier for staleness checks (queries matching records) */
  dataQuerier?: WatcherDataQuerier;
  /** Staleness check interval in ms (default: 60_000 = 1 minute) */
  stalenessIntervalMs?: number;
  /** Optional override for the watcher's stable id (default: "automation.watcher_engine"). */
  id?: string;
  logger?: Logger;
}

// ── Duration parsing ──────────────────────────────────────

/**
 * Parse a duration string (e.g. '48h', '7d', '30m', '1h30m') to milliseconds.
 * Supported units: d (days), h (hours), m (minutes), s (seconds).
 */
export function parseDuration(duration: string): number | null {
  const regex = /^(\d+)(d|h|m|s)$/;
  const match = duration.trim().match(regex);
  if (!match) return null;

  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;

  switch (unit) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "s":
      return value * 1000;
    default:
      return null;
  }
}

// ── Comparison evaluator ──────────────────────────────────

/** Evaluate a WatcherComparisonCondition against a numeric value */
export function evaluateComparison(value: number, condition: WatcherComparisonCondition): boolean {
  if (condition.gt !== undefined && !(value > condition.gt)) return false;
  if (condition.gte !== undefined && !(value >= condition.gte)) return false;
  if (condition.lt !== undefined && !(value < condition.lt)) return false;
  if (condition.lte !== undefined && !(value <= condition.lte)) return false;
  if (condition.eq !== undefined && !(value === condition.eq)) return false;
  return true;
}

// ── Implementation ────────────────────────────────────────

class WatcherEngineImpl implements WatcherEngine {
  readonly id: string;
  private registry: WatcherRegistry;
  private eventBus?: EventBusLike;
  private actionExecutor?: WatcherActionExecutor;
  private dataQuerier?: WatcherDataQuerier;
  private logger: Logger;
  private stalenessIntervalMs: number;

  private unsubscribers: Array<() => void> = [];
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private started = false;

  /** In-memory debounce state — maps `${watcherName}:${groupKey}` → state entry */
  private stateMap = new Map<string, WatcherStateEntry>();

  constructor(options: WatcherEngineOptions) {
    this.id = options.id ?? "automation.watcher_engine";
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.actionExecutor = options.actionExecutor;
    this.dataQuerier = options.dataQuerier;
    this.stalenessIntervalMs = options.stalenessIntervalMs ?? 60_000;
    this.logger = options.logger ?? {
      info: () => {},
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Subscribe to mutation events for reactive evaluation
    if (this.eventBus) {
      this.bindMutationEvents();
    }

    // Start staleness polling
    this.startStalenessPoller();

    const watcherCount = this.registry.getEnabled().length;
    this.logger.info?.(`[WatcherEngine] Started with ${watcherCount} enabled watcher(s)`);
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];

    this.started = false;
    this.logger.info?.("[WatcherEngine] Stopped");
  }

  async evaluateAfterMutation(
    entityName: string,
    record: Record<string, unknown>,
    oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult[]> {
    const watchers = this.registry.getForEntity(entityName);
    const results: WatcherEvaluationResult[] = [];

    for (const watcher of watchers) {
      try {
        const result = await this.evaluateWatcher(watcher, record, oldRecord);
        results.push(result);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.error?.(`[WatcherEngine] Error evaluating watcher "${watcher.name}": ${error}`);
        results.push({
          watcherName: watcher.name,
          fired: false,
          error,
        });
      }
    }

    return results;
  }

  getState(watcherName: string, groupKey: string): WatcherStateEntry | undefined {
    return this.stateMap.get(`${watcherName}:${groupKey}`);
  }

  resetState(watcherName: string, groupKey?: string): void {
    if (groupKey !== undefined) {
      this.stateMap.delete(`${watcherName}:${groupKey}`);
    } else {
      // Remove all entries for this watcher
      for (const key of Array.from(this.stateMap.keys())) {
        if (key.startsWith(`${watcherName}:`)) {
          this.stateMap.delete(key);
        }
      }
    }
  }

  // ── Private: event binding ──────────────────────────────

  private bindMutationEvents(): void {
    if (!this.eventBus) return;

    // Listen for record.created and record.updated events
    for (const eventType of ["record.created", "record.updated"]) {
      const unsub = this.eventBus.subscribe(eventType, async (event: EventRecord) => {
        const entityName = event.entity;
        if (!entityName) return;

        const record =
          eventType === "record.updated"
            ? ((event.payload._new as Record<string, unknown>) ?? event.payload)
            : event.payload;
        const oldRecord =
          eventType === "record.updated"
            ? (event.payload._old as Record<string, unknown>)
            : undefined;

        await this.evaluateAfterMutation(entityName, record, oldRecord);
      });
      this.unsubscribers.push(unsub);
    }
  }

  // ── Private: staleness polling ──────────────────────────

  private startStalenessPoller(): void {
    const stalenessWatchers = this.registry
      .getEnabled()
      .filter((w) => w.trigger.type === "staleness");

    if (stalenessWatchers.length === 0) return;
    if (!this.dataQuerier) {
      this.logger.warn?.(
        "[WatcherEngine] Staleness watchers registered but no dataQuerier provided",
      );
      return;
    }

    const interval = setInterval(async () => {
      for (const watcher of stalenessWatchers) {
        // Re-check enabled status
        const current = this.registry.get(watcher.name);
        if (!current?.enabled) continue;

        try {
          await this.evaluateStalenessWatcher(current);
        } catch (err) {
          this.logger.error?.(
            `[WatcherEngine] Staleness check error for "${watcher.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }, this.stalenessIntervalMs);

    this.intervals.push(interval);
  }

  // ── Private: evaluate a single watcher ──────────────────

  private async evaluateWatcher(
    watcher: WatcherDefinition,
    record: Record<string, unknown>,
    oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;

    // For set_change watchers, the filter is evaluated internally
    // (old vs new against filter). For other types, apply filter as a pre-check.
    if (trigger.type !== "set_change" && watcher.watch.filter) {
      const ctx: ConditionContext = {
        target: record,
        context: {},
        actor: { type: "system", id: "watcher", groups: [] },
      };
      if (!evaluateCondition(watcher.watch.filter, ctx)) {
        return { watcherName: watcher.name, fired: false, reason: "filter_not_matched" };
      }
    }

    switch (trigger.type) {
      case "threshold":
        return this.evaluateThresholdWatcher(watcher, record, oldRecord);

      case "set_change":
        return this.evaluateSetChangeWatcher(watcher, record, oldRecord);

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

  private async evaluateThresholdWatcher(
    watcher: WatcherDefinition,
    record: Record<string, unknown>,
    _oldRecord?: Record<string, unknown>,
  ): Promise<WatcherEvaluationResult> {
    const trigger = watcher.trigger;
    if (trigger.type !== "threshold") {
      return { watcherName: watcher.name, fired: false, reason: "wrong_trigger_type" };
    }

    // Determine the value to compare
    let currentValue: number;

    if (watcher.watch.aggregate) {
      // Aggregate watchers need a data querier to compute aggregates
      if (!this.dataQuerier) {
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "no_data_querier_for_aggregate",
        };
      }

      const records = await this.dataQuerier.queryRecords(watcher.watch.entity);
      // Apply filter in-memory if present
      const watchFilter = watcher.watch.filter;
      const filtered = watchFilter
        ? records.filter((r) => {
            const ctx: ConditionContext = {
              target: r,
              context: {},
              actor: { type: "system", id: "watcher", groups: [] },
            };
            return evaluateCondition(watchFilter, ctx);
          })
        : records;

      currentValue = this.computeAggregate(filtered, watcher.watch.aggregate);
    } else {
      // Single-record: read the field value directly
      const fieldName = trigger.field;
      if (!fieldName) {
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "no_field_specified",
        };
      }
      const rawValue = record[fieldName];
      if (typeof rawValue !== "number") {
        return {
          watcherName: watcher.name,
          fired: false,
          reason: "field_not_numeric",
        };
      }
      currentValue = rawValue;
    }

    const conditionMet = evaluateComparison(currentValue, trigger.condition);
    const groupKey = this.getGroupKey(watcher, record);

    // Debounce check
    if (!this.shouldFire(watcher, groupKey, conditionMet)) {
      return { watcherName: watcher.name, fired: false, reason: "debounced" };
    }

    // Fire the effect
    const ctx: WatcherContext = {
      record,
      value: currentValue,
      watcherName: watcher.name,
    };

    await this.fireEffect(watcher, ctx);

    // Update state
    this.updateState(watcher.name, groupKey, conditionMet);

    return { watcherName: watcher.name, fired: true };
  }

  // ── Set-change evaluation ───────────────────────────────

  private async evaluateSetChangeWatcher(
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
      return {
        watcherName: watcher.name,
        fired: false,
        reason: "set_change_requires_filter",
      };
    }

    const newMatchesFilter = evaluateCondition(filter, {
      target: record,
      context: {},
      actor: { type: "system", id: "watcher", groups: [] },
    });

    const oldMatchesFilter = oldRecord
      ? evaluateCondition(filter, {
          target: oldRecord,
          context: {},
          actor: { type: "system", id: "watcher", groups: [] },
        })
      : false;

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

    if (!this.shouldFire(watcher, groupKey, true)) {
      return { watcherName: watcher.name, fired: false, reason: "debounced" };
    }

    const ctx: WatcherContext = {
      record,
      watcherName: watcher.name,
    };

    await this.fireEffect(watcher, ctx);
    this.updateState(watcher.name, groupKey, true);

    return { watcherName: watcher.name, fired: true };
  }

  // ── Staleness evaluation ────────────────────────────────

  private async evaluateStalenessWatcher(watcher: WatcherDefinition): Promise<void> {
    const trigger = watcher.trigger;
    if (trigger.type !== "staleness" || !this.dataQuerier) return;

    const thresholdMs = parseDuration(trigger.threshold);
    if (thresholdMs === null) {
      this.logger.warn?.(
        `[WatcherEngine] Cannot parse staleness threshold "${trigger.threshold}" for watcher "${watcher.name}"`,
      );
      return;
    }

    const records = await this.dataQuerier.queryRecords(watcher.watch.entity);

    // Apply filter
    const watchFilter2 = watcher.watch.filter;
    const filtered = watchFilter2
      ? records.filter((r) => {
          const ctx: ConditionContext = {
            target: r,
            context: {},
            actor: { type: "system", id: "watcher", groups: [] },
          };
          return evaluateCondition(watchFilter2, ctx);
        })
      : records;

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
        // Condition no longer met — update state so it can fire again
        const stateKey = `${watcher.name}:${groupKey}`;
        const existing = this.stateMap.get(stateKey);
        if (existing?.conditionMet) {
          existing.conditionMet = false;
        }
        continue;
      }

      if (!this.shouldFire(watcher, groupKey, true)) {
        continue;
      }

      const ctx: WatcherContext = {
        record,
        watcherName: watcher.name,
      };

      await this.fireEffect(watcher, ctx);
      this.updateState(watcher.name, groupKey, true);
    }
  }

  // ── Aggregate computation ───────────────────────────────

  private computeAggregate(
    records: Array<Record<string, unknown>>,
    config: { field: string; op: string; groupBy?: string },
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

  // ── Effect execution ────────────────────────────────────

  private async fireEffect(watcher: WatcherDefinition, ctx: WatcherContext): Promise<void> {
    if (!this.actionExecutor) {
      this.logger.warn?.(
        `[WatcherEngine] No actionExecutor configured, cannot fire effect for "${watcher.name}"`,
      );
      return;
    }

    const params =
      typeof watcher.effect.params === "function"
        ? watcher.effect.params(ctx)
        : { ...watcher.effect.params };

    // Inject watcher context metadata
    const input = { ...params, _watcher: { name: watcher.name } };

    this.logger.info?.(
      `[WatcherEngine] Firing watcher "${watcher.name}" → action "${watcher.effect.action}"`,
    );

    await this.actionExecutor.executeAction(watcher.effect.action, input);
  }

  // ── Debounce logic ──────────────────────────────────────

  private getGroupKey(watcher: WatcherDefinition, record: Record<string, unknown>): string {
    if (watcher.watch.aggregate?.groupBy) {
      return String(record[watcher.watch.aggregate.groupBy] ?? "default");
    }
    // Use record ID as group key for per-record watchers
    return String(record.id ?? "default");
  }

  /**
   * Check whether the watcher should fire based on debounce strategy.
   * Returns true if the watcher should fire.
   */
  private shouldFire(watcher: WatcherDefinition, groupKey: string, conditionMet: boolean): boolean {
    if (!conditionMet) return false;

    const debounce = watcher.trigger.debounce;
    if (!debounce) return true; // No debounce — always fire

    const stateKey = `${watcher.name}:${groupKey}`;
    const state = this.stateMap.get(stateKey);

    switch (debounce) {
      case "once_until_reset": {
        // Fire only when condition transitions from false→true
        if (state?.conditionMet) {
          return false; // Already fired and condition still met
        }
        return true;
      }

      case "once_per_record": {
        // Fire once per group key, never again
        if (state?.lastFiredAt) {
          return false;
        }
        return true;
      }

      case "cooldown": {
        if (!state?.lastFiredAt) return true;

        const cooldownStr = watcher.trigger.cooldownPeriod ?? "1h";
        const cooldownMs = parseDuration(cooldownStr);
        if (cooldownMs === null) return true;

        const elapsed = Date.now() - state.lastFiredAt.getTime();
        return elapsed >= cooldownMs;
      }

      default:
        return true;
    }
  }

  private updateState(watcherName: string, groupKey: string, conditionMet: boolean): void {
    const stateKey = `${watcherName}:${groupKey}`;
    this.stateMap.set(stateKey, {
      watcherName,
      groupKey,
      lastFiredAt: new Date(),
      conditionMet,
    });
  }
}

// ── Factory ──────────────────────────────────────────────

/** Create a new WatcherEngine */
export function createWatcherEngine(options: WatcherEngineOptions): WatcherEngine {
  return new WatcherEngineImpl(options);
}
