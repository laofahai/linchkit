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
}

/**
 * Create an opt-in evolution-cycle scheduler. The returned scheduler is INERT
 * until `start()` is called.
 */
export function createEvolutionScheduler(options: EvolutionSchedulerOptions): EvolutionScheduler {
  const { tick, runImmediately = false, logger = consoleLogger, onError } = options;
  const requested = options.intervalMs;
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Math.floor(
      typeof requested === "number" && Number.isFinite(requested) ? requested : MIN_INTERVAL_MS,
    ),
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let ticking = false;

  async function runOnce(): Promise<boolean> {
    // Non-overlapping: never start a tick while one is already running.
    if (ticking) return false;
    ticking = true;
    try {
      await tick();
    } catch (err) {
      if (onError) {
        onError(err);
      } else {
        logger.warn(
          `[EvolutionScheduler] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
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
  };
}
