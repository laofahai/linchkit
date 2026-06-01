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
  WatcherContext,
  WatcherDefinition,
  WatcherEvaluationResult,
  WatcherStateEntry,
} from "@linchkit/core";
import type { WatcherRegistry } from "@linchkit/core/server";
import { MutationEngine } from "./mutation-engine";
import { ScheduleEngine } from "./schedule-engine";
import { evaluateComparison, parseDuration } from "./watcher-conditions";
import { WatcherStatePersistence } from "./watcher-state-persistence";
import type { WatcherStateStore } from "./watcher-state-store";

// Re-exported for the public surface (and existing consumers / tests that import
// these from `./watcher-engine`). The implementations live in
// `./watcher-conditions` to keep this file under the 500-line ceiling.
export { evaluateComparison, parseDuration } from "./watcher-conditions";

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

  /**
   * Evaluate all `schedule` watchers whose cron occurrence is due at the
   * current clock time, firing each that passes its optional count condition.
   *
   * In production this is invoked on an internal interval started by
   * {@link Watcher.start}. Tests can call it directly after advancing the
   * injected clock to drive the scheduler deterministically without timers.
   * Returns one result per evaluated (due) occurrence.
   */
  runScheduleTick(): Promise<WatcherEvaluationResult[]>;

  /** Get a scheduled watcher's next-due time (for testing/debugging). */
  getNextScheduledRun(watcherName: string): Date | null | undefined;

  /**
   * Hydrate the in-memory debounce cache from the configured persistent
   * {@link WatcherStateStore}. Called automatically by {@link Watcher.start},
   * but exposed so a freshly constructed engine (e.g. simulating a process
   * restart in tests, or a startup path that does not call `start()`) can
   * restore debounce state explicitly. No-op when no store is configured.
   */
  hydrate(): Promise<void>;

  /**
   * Resolve once all write-through persistence enqueued so far has been applied
   * to the backing store. Write-through is fire-and-forget and serialized, so
   * the durable store is only EVENTUALLY consistent with the in-memory cache;
   * this lets a caller (graceful shutdown, or a test asserting persisted state)
   * await that the queued mirror writes have drained. Resolves immediately when
   * no store is configured. Never rejects — store-write failures are logged
   * inside the chain, not surfaced here.
   */
  whenPersisted(): Promise<void>;
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
  /**
   * Schedule (cron) tick interval in ms (default: 60_000 = 1 minute).
   * The scheduler re-checks due crons on each tick; cron resolution finer than
   * this interval is not meaningful. Tests bypass the timer via
   * {@link WatcherEngine.runScheduleTick}.
   */
  scheduleIntervalMs?: number;
  /**
   * Injectable clock — returns the current time. Defaults to `() => new Date()`.
   * Drives the schedule trigger so tests can advance time deterministically.
   */
  clock?: () => Date;
  /** Optional override for the watcher's stable id (default: "automation.watcher_engine"). */
  id?: string;
  logger?: Logger;
  /**
   * Optional durable backing store for debounce state (Spec 45 §4). When
   * provided, the engine keeps its in-memory `Map` as a hot cache but writes
   * every mutation through to the store and re-hydrates the cache from it on
   * {@link WatcherEngine.hydrate} / {@link Watcher.start} — making debounce
   * state restart-safe. When omitted, the engine is a pure in-memory `Map`
   * (historical behavior, unchanged).
   */
  stateStore?: WatcherStateStore;
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
  private scheduleIntervalMs: number;
  private clock: () => Date;

  private unsubscribers: Array<() => void> = [];
  private started = false;

  /** In-memory debounce state — maps `${watcherName}:${groupKey}` → state entry */
  private stateMap = new Map<string, WatcherStateEntry>();

  /**
   * Optional durable-persistence collaborator. When set, `stateMap` acts as a
   * synchronous hot cache and every mutation is mirrored to the backing store
   * (write-through, serialized); {@link hydrate} reloads the cache from it. When
   * undefined the engine is a pure in-memory `Map` (historical behavior).
   */
  private persistence?: WatcherStatePersistence;

  /** Cron scheduling subsystem (next-due tracking + tick evaluation). */
  private scheduleEngine: ScheduleEngine;

  /** Reactive (threshold/set_change) + staleness evaluation subsystem. */
  private mutationEngine: MutationEngine;

  constructor(options: WatcherEngineOptions) {
    this.id = options.id ?? "automation.watcher_engine";
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.actionExecutor = options.actionExecutor;
    this.dataQuerier = options.dataQuerier;
    this.stalenessIntervalMs = options.stalenessIntervalMs ?? 60_000;
    this.scheduleIntervalMs = options.scheduleIntervalMs ?? 60_000;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? {
      info: () => {},
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };

    // Allocate the durable-persistence collaborator only when a store is
    // configured; otherwise the engine stays a pure in-memory `Map` with zero
    // persistence overhead (historical behavior, byte-for-byte unchanged).
    if (options.stateStore) {
      this.persistence = new WatcherStatePersistence({
        store: options.stateStore,
        logger: this.logger,
      });
    }

    // Delegate cron scheduling to a dedicated subsystem. Debounce + effect
    // concerns are passed back as bound callbacks so the engine retains sole
    // ownership of the shared debounce state map.
    this.scheduleEngine = new ScheduleEngine({
      registry: this.registry,
      dataQuerier: this.dataQuerier,
      logger: this.logger,
      clock: this.clock,
      scheduleIntervalMs: this.scheduleIntervalMs,
      evaluateComparison,
      shouldFire: (watcher, groupKey, conditionMet) =>
        this.shouldFire(watcher, groupKey, conditionMet),
      fireEffect: (watcher, ctx) => this.fireEffect(watcher, ctx),
      updateState: (watcherName, groupKey, conditionMet) =>
        this.updateState(watcherName, groupKey, conditionMet),
    });

    // Reactive + staleness evaluation, sharing the same debounce collaborators.
    this.mutationEngine = new MutationEngine({
      registry: this.registry,
      dataQuerier: this.dataQuerier,
      logger: this.logger,
      stalenessIntervalMs: this.stalenessIntervalMs,
      evaluateComparison,
      parseDuration,
      shouldFire: (watcher, groupKey, conditionMet) =>
        this.shouldFire(watcher, groupKey, conditionMet),
      fireEffect: (watcher, ctx) => this.fireEffect(watcher, ctx),
      updateState: (watcherName, groupKey, conditionMet) =>
        this.updateState(watcherName, groupKey, conditionMet),
      resetConditionMet: (watcherName, groupKey) => this.resetConditionMet(watcherName, groupKey),
    });
  }

  start(): void | Promise<void> {
    if (this.started) return;
    this.started = true;

    // Fast path — no persistent store: start synchronously so behavior is
    // byte-for-byte identical to the historical in-memory-only engine (callers
    // that emit immediately after `start()` without awaiting still work).
    if (!this.persistence) {
      this.startSubsystems();
      return;
    }

    // Store configured: restore debounce state BEFORE any evaluation path runs,
    // so a restarted engine does not re-fire already-fired watchers. Returns a
    // promise the caller can await; subsystems start only after hydration.
    return this.hydrate().then(() => {
      // Guard against a stop() that raced the in-flight hydration: if the engine
      // was stopped while we awaited, do NOT bind subscriptions/timers after
      // shutdown.
      if (!this.started) return;
      this.startSubsystems();
    });
  }

  /** Bind event subscriptions and start the polling/schedule subsystems. */
  private startSubsystems(): void {
    // Subscribe to mutation events for reactive evaluation
    if (this.eventBus) {
      this.bindMutationEvents();
    }

    // Start staleness polling
    this.mutationEngine.start();

    // Start cron scheduler
    this.scheduleEngine.start();

    const watcherCount = this.registry.getEnabled().length;
    this.logger.info?.(`[WatcherEngine] Started with ${watcherCount} enabled watcher(s)`);
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.mutationEngine.stop();
    this.scheduleEngine.stop();

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
        const result = await this.mutationEngine.evaluate(watcher, record, oldRecord);
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
      this.persistence?.delete(watcherName, groupKey);
    } else {
      // Remove all entries for this watcher
      for (const key of Array.from(this.stateMap.keys())) {
        if (key.startsWith(`${watcherName}:`)) {
          this.stateMap.delete(key);
        }
      }
      this.persistence?.clearForWatcher(watcherName);
    }
  }

  getNextScheduledRun(watcherName: string): Date | null | undefined {
    return this.scheduleEngine.getNextScheduledRun(watcherName);
  }

  async hydrate(): Promise<void> {
    // Delegate to the persistence collaborator, which REPLACES the cache (clears
    // first, then loads) so keys deleted from the store never linger across a
    // stop()→start() or a repeated hydrate. No-op when no store is configured.
    await this.persistence?.hydrate(this.stateMap);
  }

  async whenPersisted(): Promise<void> {
    await this.persistence?.whenSettled();
  }

  runScheduleTick(): Promise<WatcherEvaluationResult[]> {
    return this.scheduleEngine.runTick();
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

        // Use the injectable clock so cooldown is deterministic in tests and
        // consistent with schedule evaluation.
        const elapsed = this.clock().getTime() - state.lastFiredAt.getTime();
        return elapsed >= cooldownMs;
      }

      default:
        return true;
    }
  }

  private updateState(watcherName: string, groupKey: string, conditionMet: boolean): void {
    const stateKey = `${watcherName}:${groupKey}`;
    const entry: WatcherStateEntry = {
      watcherName,
      groupKey,
      lastFiredAt: this.clock(),
      conditionMet,
    };
    this.stateMap.set(stateKey, entry);
    this.persistence?.set(watcherName, groupKey, entry);
  }

  /**
   * Clear the `conditionMet` flag for a group (used by staleness evaluation when
   * a record is no longer stale) so a `once_until_reset` watcher can fire again
   * once the condition re-occurs. No-op when no state exists for the group.
   */
  private resetConditionMet(watcherName: string, groupKey: string): void {
    const existing = this.stateMap.get(`${watcherName}:${groupKey}`);
    if (existing?.conditionMet) {
      existing.conditionMet = false;
      this.persistence?.set(watcherName, groupKey, existing);
    }
  }
}

// ── Factory ──────────────────────────────────────────────

/** Create a new WatcherEngine */
export function createWatcherEngine(options: WatcherEngineOptions): WatcherEngine {
  return new WatcherEngineImpl(options);
}
