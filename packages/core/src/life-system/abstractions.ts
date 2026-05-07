/**
 * Life-system abstractions — Spec 55 / Spec 56 Phase 2 Step 2a.
 *
 * Pure interface contracts for the five-layer life-system:
 *   Sense → Memory → Awareness → Insight → Proposal
 *
 * These interfaces are intentionally minimal and additive. Concrete
 * implementations (PatternDetector, AnomalyDetector, WatcherEngine,
 * persistent stores, ...) continue to live where they are today; this
 * module only declares the public contracts that capabilities can target.
 *
 * Capabilities import these via:
 *   import type { Sensor, Signal, Baseline, MemoryStore } from "@linchkit/core";
 *
 * @see docs/specs/55_evolution_system.md
 * @see docs/specs/56_core_slimming.md (Phase 2 Step 2a)
 */

// ── Common helpers ─────────────────────────────────────────────────────────

/**
 * Function returned by subscription APIs. Calling it removes the registered
 * handler. Idempotent — calling more than once is a no-op.
 */
export type Unsubscribe = () => void;

// ── Sense layer ────────────────────────────────────────────────────────────

/**
 * A single observation produced by a {@link Sensor}.
 *
 * Signals are the unit of currency between the Sense and Memory layers.
 * They are intentionally opaque on the {@link Signal.data} field — the
 * MemoryStore / Awareness layer interprets the payload based on `kind`.
 *
 * Spec 55 §3.1: Signals flow in from multiple channels (event_bus, server,
 * api, graphql, mcp, ui). The `source` string identifies the channel.
 */
export interface Signal {
  /**
   * Origin channel of the signal — typically a SignalSource value
   * (`event_bus`, `server`, `api`, `graphql`, `mcp`, `ui`) but kept as a
   * plain string so capabilities can introduce custom channels without
   * widening a core enum.
   */
  source: string;

  /**
   * Discriminator describing what the signal represents
   * (e.g. `action.failed`, `friction.abandon`, `query.slow`). Consumers
   * dispatch on `kind` before unpacking `data`.
   */
  kind: string;

  /**
   * Opaque payload. Sensors are responsible for shaping `data` to match
   * the contract implied by `kind`. Kept as `unknown` so this interface
   * does not leak any specific schema.
   */
  data: unknown;

  /**
   * Wall-clock time the signal was produced, in milliseconds since the
   * Unix epoch. Use a number rather than `Date` so signals serialize
   * trivially across IPC / persistence boundaries.
   */
  timestamp: number;

  /**
   * Optional bag of side-channel attributes — trace IDs, tenant IDs,
   * actor info, etc. Kept open-ended (`Record<string, unknown>`) so
   * capabilities can attach context without coordinating a schema.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Sensor — Sense-layer lifecycle contract (Spec 55 §3.3).
 *
 * Capabilities register sensors via `extensions.sensors`. The runtime
 * starts each sensor at boot, fans signals out to subscribers via
 * {@link Sensor.subscribe}, and stops them on shutdown.
 *
 * This is a *push* contract: sensors emit signals into the bus instead
 * of being polled. (A separate, detection-style interface exists for
 * pull-based sensors used by the EvolutionCycle.)
 */
export interface Sensor {
  /**
   * Stable, globally unique identifier for this sensor instance.
   * Conventionally `<capability>.<sensor_name>` (e.g.
   * `purchase.rejection_pattern`). Used as the registry key — duplicates
   * are rejected by the sensor registry.
   */
  readonly id: string;

  /**
   * Begin producing signals. Called once during system startup, after the
   * sensor has been registered. Implementations may open subscriptions,
   * schedule timers, or simply mark themselves active. Idempotent.
   */
  start(): Promise<void> | void;

  /**
   * Stop producing signals and release any resources acquired by
   * {@link Sensor.start}. Called once during shutdown. Must be idempotent
   * so the runtime can safely call it on an already-stopped sensor.
   */
  stop(): Promise<void> | void;

  /**
   * Subscribe to signals emitted by this sensor.
   *
   * Multiple subscribers are supported; each receives every signal in
   * the order emitted. The returned {@link Unsubscribe} function removes
   * the handler. Handlers are invoked synchronously from the sensor's
   * emit path — long-running work should be offloaded.
   */
  subscribe(handler: (signal: Signal) => void): Unsubscribe;
}

// ── Memory layer ───────────────────────────────────────────────────────────

/**
 * Baseline — captures normal-state statistics for anomaly detection
 * (Spec 55 §4.2).
 *
 * A Baseline is a learned distribution: feed it observations via
 * {@link Baseline.update}, then query {@link Baseline.score} to ask
 * "how anomalous is this new observation?". The 0..1 scale is fixed by
 * contract so consumers can compare scores across baseline implementations.
 */
export interface Baseline {
  /**
   * Stable identifier. Conventionally `<entity>.<metric>` (e.g.
   * `purchase_request.rejection_rate`). Used by the Memory layer as the
   * key under which the baseline is persisted.
   */
  readonly id: string;

  /**
   * Incorporate a new observation into the baseline. The shape of
   * `observation` is defined by the implementation (number, vector,
   * structured record, ...). Should be O(1) where possible so the
   * memory layer can call this on every signal.
   */
  update(observation: unknown): void;

  /**
   * Score an observation against the learned baseline. Returns a value
   * in `[0, 1]`:
   *   - `0` → perfectly in-distribution (no anomaly)
   *   - `1` → maximally anomalous given the current baseline
   * Implementations should clamp out-of-range internal scores to this
   * interval rather than throwing.
   */
  score(observation: unknown): number;

  /**
   * Return a serialisable snapshot of the baseline's internal state.
   * Used by the Memory layer to persist baselines across restarts and
   * to drive UI / debugging surfaces. The return value is `unknown`
   * because each baseline implementation chooses its own shape.
   */
  snapshot(): unknown;
}

/**
 * MemoryStore — generic key/value abstraction over the Memory layer.
 *
 * Provides a minimal contract that capabilities can target without
 * coupling to a specific storage backend (Postgres, Redis, in-memory).
 *
 * All methods are async so implementations are free to perform I/O.
 * Values are `unknown` — Memory consumers are expected to know what
 * shape they wrote under each key.
 */
export interface MemoryStore {
  /**
   * Read the value previously written under `key`. Returns `null` when
   * the key is absent or expired. Never throws on missing keys.
   */
  read(key: string): Promise<unknown | null>;

  /**
   * Write `value` under `key`, replacing any existing entry. The optional
   * {@link MemoryStoreWriteOptions.ttlMs} sets a relative time-to-live
   * after which the entry should be considered expired by {@link MemoryStore.read}
   * and {@link MemoryStore.list}.
   */
  write(key: string, value: unknown, options?: MemoryStoreWriteOptions): Promise<void>;

  /**
   * Remove the entry stored under `key`. Removing a missing key is a
   * no-op (does not throw).
   */
  delete(key: string): Promise<void>;

  /**
   * Enumerate keys currently in the store, optionally filtered by
   * prefix. Implementations should exclude expired entries from the
   * returned list.
   */
  list(prefix?: string): Promise<string[]>;
}

/**
 * Options for {@link MemoryStore.write}.
 *
 * Kept as a named interface rather than an inline literal so additional
 * fields (compaction hints, tags, ...) can be added without breaking
 * existing implementations.
 */
export interface MemoryStoreWriteOptions {
  /**
   * Time-to-live in milliseconds, measured from the moment of the write.
   * After this many milliseconds the entry should behave as if it had
   * been deleted. Omit for entries that should persist until explicitly
   * deleted.
   */
  ttlMs?: number;
}
