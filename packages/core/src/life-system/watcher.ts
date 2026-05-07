/**
 * Watcher — abstract Sense-layer contract (Spec 55 / Spec 56 Phase 2 Step 2c).
 *
 * A Watcher is a long-lived component that observes some condition (data,
 * timers, external streams, ...) and fires effects when the condition is
 * met. Concrete watcher engines — the data-condition WatcherEngine
 * (Spec 45), schedule-based watchers, external-source watchers, ... — live
 * in capabilities (e.g. `cap-ai-provider`). Core keeps this minimal
 * interface so capabilities can register watchers, and runtimes can manage
 * their lifecycle, without coupling to a specific implementation.
 *
 * NOTE: This is distinct from the `WatcherDefinition` declarative shape in
 * `../types/watcher.ts`, which describes a *single* declarative watcher (its
 * trigger, watch target, and effect). `Watcher` here is the lifecycle
 * contract for an *engine* (or other agent) that owns one or more such
 * declarative watchers and manages their start/stop lifetime.
 *
 * @see docs/specs/55_evolution_system.md (Sense layer)
 * @see docs/specs/56_core_slimming.md (Phase 2 Step 2c)
 */
export interface Watcher {
  /**
   * Stable identifier for this watcher instance. Conventionally
   * `<capability>.<watcher_name>` (e.g. `ai.watcher_engine`). Used by
   * registries / DI containers as a lookup key.
   */
  readonly id: string;

  /**
   * Begin watching. Called once during system startup. Implementations may
   * subscribe to event buses, schedule timers, or open external streams.
   * Should be idempotent — calling `start()` on an already-started watcher
   * is a no-op.
   */
  start(): Promise<void> | void;

  /**
   * Stop watching and release any resources acquired by {@link Watcher.start}.
   * Called once during shutdown. Should be idempotent so the runtime can
   * safely call it on an already-stopped watcher.
   */
  stop(): Promise<void> | void;
}
