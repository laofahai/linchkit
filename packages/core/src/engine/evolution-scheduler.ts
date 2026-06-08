/**
 * EvolutionScheduler — opt-in cadence for the evolution cycle (Spec 55 §7).
 *
 * Runs a caller-provided `tick` on a fixed interval — typically "run one
 * evolution cycle and persist its proposals as governance DRAFTS". This is the
 * autonomous-sensing knob: it makes the Sense → Insight → Proposal-DRAFT loop run
 * on a timer instead of only on an operator's button press.
 *
 * SAFETY ("AI never modifies production directly"):
 *   - OFF unless explicitly constructed AND started — nothing schedules itself.
 *   - It only ever runs the injected `tick`. The intended tick produces
 *     governance DRAFTS only (`persistCycleProposalsAsDrafts`); it NEVER submits,
 *     approves, commits, graduates, or materializes. Approval and graduation stay
 *     human-gated regardless of cadence.
 *   - Ticks are NON-OVERLAPPING — a slow cycle never piles up.
 *   - The interval is floored ({@link MIN_INTERVAL_MS}) so a misconfiguration
 *     can't hammer the runtime.
 *   - A thrown tick is caught and logged (or routed to `onError`); the scheduler
 *     keeps running.
 *
 * Lifecycle: create → start() → stop(). Generic over `tick` so core stays
 * decoupled from the proposal engine — the wiring composes runCycle + persist.
 */

import { consoleLogger } from "../observability/console-logger";
import type { Logger } from "../types/logger";

/** Hard floor on the tick interval. Evolution cycles are expensive; operators
 * should use minutes, but the floor only guards against 0 / negative / sub-second
 * misconfigurations that would hammer the runtime. */
export const MIN_INTERVAL_MS = 1000;

/**
 * Hard ceiling on the tick interval (= 2^31 - 1 ms ≈ 24.8 days). `setInterval`
 * stores its delay in a signed 32-bit int in both Node and Bun: a delay above
 * this overflows and is silently coerced to 1ms, which would make a "once a
 * month" cadence hammer the runtime every millisecond. Clamping keeps an
 * over-large interval as "effectively never fires" instead of "fires constantly".
 */
export const MAX_INTERVAL_MS = 2_147_483_647;

export interface EvolutionSchedulerOptions {
  /**
   * Work to run each tick — typically: run one evolution cycle and persist its
   * proposals as governance drafts. May be sync or async; the scheduler awaits it.
   */
  tick: () => Promise<unknown> | unknown;
  /** Interval between ticks (ms). Floored at {@link MIN_INTERVAL_MS}. */
  intervalMs: number;
  /** Run a tick immediately on start (default false — first tick after one interval). */
  runImmediately?: boolean;
  /** Logger (defaults to the console logger). */
  logger?: Logger;
  /** Called when a tick throws. When omitted, the error is logged via `logger.warn`. */
  onError?: (err: unknown) => void;
}

/**
 * Read-only liveness snapshot of the scheduler (Spec 55 §7) — lets a human
 * operator see whether the autonomous cadence loop is actually alive (ticking,
 * succeeding, or stuck erroring) without any side effect. Surfaced over HTTP by
 * the adapter-server.
 */
export interface EvolutionSchedulerStatus {
  /** True between start() and stop(). */
  running: boolean;
  /** The clamped interval actually in use (ms) — after MIN/MAX clamping. */
  intervalMs: number;
  /** Count of ticks begun (incremented before each tick body runs). */
  ticksStarted: number;
  /** Count of ticks that finished — whether they completed OK or threw. */
  ticksCompleted: number;
  /** When the most recent tick started, or null if none has started yet. */
  lastTickStartedAt: Date | null;
  /** When the most recent tick finished, or null if none has finished yet. */
  lastTickCompletedAt: Date | null;
  /** Duration of the most recent finished tick (ms), or null if none finished. */
  lastTickDurationMs: number | null;
  /** Message of the most recent tick error, or null if the last tick was OK. */
  lastError: string | null;
  /** Errors in a row; resets to 0 on a successful tick. */
  consecutiveErrors: number;
}

export interface EvolutionScheduler {
  /** Begin ticking on the interval. Idempotent — a second call is a no-op. */
  start(): void;
  /** Stop ticking (clears the timer). A tick already in flight runs to completion. */
  stop(): void;
  /** True between start() and stop(). */
  isRunning(): boolean;
  /** True while a tick is currently executing. */
  isTicking(): boolean;
  /**
   * Run one tick now and await it. Skips (returns false) if a tick is already in
   * flight — preserving the non-overlapping guarantee. Returns true if it ran
   * (even if the tick threw — the throw is caught and reported).
   */
  runOnce(): Promise<boolean>;
  /**
   * Read-only liveness snapshot (counters + timing + last error). Pure — calling
   * it has no side effect and does not advance the schedule. Returns a fresh
   * object on each call (timestamps are cloned) so callers can't mutate state.
   */
  getStatus(): EvolutionSchedulerStatus;
}

/**
 * Create an opt-in evolution-cycle scheduler. The returned scheduler is INERT
 * until `start()` is called.
 */
export function createEvolutionScheduler(options: EvolutionSchedulerOptions): EvolutionScheduler {
  const { tick, runImmediately = false, logger = consoleLogger, onError } = options;
  const requested = options.intervalMs;
  // Clamp to [MIN, MAX]: the floor guards against hammering the runtime, the
  // ceiling guards against setInterval's signed-32-bit overflow (a too-large
  // delay would coerce to 1ms and fire constantly — see MAX_INTERVAL_MS).
  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(
      MIN_INTERVAL_MS,
      Math.floor(
        typeof requested === "number" && Number.isFinite(requested) ? requested : MIN_INTERVAL_MS,
      ),
    ),
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let ticking = false;

  // ── Liveness counters (read-only via getStatus) ──────────────────────
  // Mutated only inside runOnce. setInterval is real runtime time here (not a
  // deterministic workflow), so new Date() is appropriate for the timestamps.
  let ticksStarted = 0;
  let ticksCompleted = 0;
  let lastTickStartedAt: Date | null = null;
  let lastTickCompletedAt: Date | null = null;
  let lastTickDurationMs: number | null = null;
  let lastError: string | null = null;
  let consecutiveErrors = 0;

  async function runOnce(): Promise<boolean> {
    // Non-overlapping: never start a tick while one is already running.
    if (ticking) return false;
    ticking = true;
    ticksStarted += 1;
    const startedAt = new Date();
    lastTickStartedAt = startedAt;
    try {
      await tick();
      // Success path: clear the error streak so a recovered loop reads "healthy".
      lastError = null;
      consecutiveErrors = 0;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      consecutiveErrors += 1;
      if (onError) {
        onError(err);
      } else {
        logger.warn(`[EvolutionScheduler] tick failed: ${lastError}`);
      }
    } finally {
      const completedAt = new Date();
      lastTickCompletedAt = completedAt;
      lastTickDurationMs = completedAt.getTime() - startedAt.getTime();
      ticksCompleted += 1;
      ticking = false;
    }
    return true;
  }

  return {
    start() {
      if (started) return;
      started = true;
      logger.info(
        `[EvolutionScheduler] started — interval ${intervalMs}ms. DRAFT-only cadence: ` +
          "approval and graduation stay human-gated.",
      );
      if (runImmediately) void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      // Don't keep the process alive just for the cadence timer.
      (timer as unknown as { unref?: () => void })?.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      started = false;
    },
    isRunning() {
      return started;
    },
    isTicking() {
      return ticking;
    },
    runOnce,
    getStatus(): EvolutionSchedulerStatus {
      // Clone the Date fields so a caller can't mutate the scheduler's internal
      // timestamps through the returned snapshot.
      return {
        running: started,
        intervalMs,
        ticksStarted,
        ticksCompleted,
        lastTickStartedAt: lastTickStartedAt ? new Date(lastTickStartedAt) : null,
        lastTickCompletedAt: lastTickCompletedAt ? new Date(lastTickCompletedAt) : null,
        lastTickDurationMs,
        lastError,
        consecutiveErrors,
      };
    },
  };
}
