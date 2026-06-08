/**
 * Opt-in evolution cadence wiring (Spec 55 §7) — adapter-server.
 *
 * Composes the core {@link createEvolutionScheduler} with a "run one cycle →
 * persist its proposals as governance DRAFTS" tick, so an operator can have the
 * Sense → Insight → Proposal-DRAFT loop run on a timer instead of only via
 * `POST /api/evolution/run-cycle`.
 *
 * SAFETY ("AI never modifies production directly"):
 *   - OFF by default. Enabled ONLY when `EVOLUTION_CADENCE_INTERVAL_MS` is set to
 *     a positive integer (milliseconds). Unset / non-numeric / ≤ 0 → disabled.
 *   - The tick produces governance DRAFTS only (`persistCycleProposalsAsDrafts`):
 *     it NEVER submits, approves, commits, graduates, or materializes. Approval
 *     and graduation stay human-gated regardless of cadence.
 *   - No scheduler is created when no evolution runtime is wired.
 */

import type { Logger } from "@linchkit/core";
import type { EvolutionRuntime, ProposalEngine } from "@linchkit/core/server";
import {
  consoleLogger,
  createEvolutionScheduler,
  type EvolutionScheduler,
  persistCycleProposalsAsDrafts,
} from "@linchkit/core/server";
import { getSharedProposalEngine } from "./proposal-api";

/** Env var that opts a deployment into autonomous evolution cadence. */
export const CADENCE_ENV_KEY = "EVOLUTION_CADENCE_INTERVAL_MS";

/**
 * Resolve the cadence interval (ms) from the environment. Returns `null` (OFF)
 * unless the var is set to a positive, finite integer — cadence is strictly
 * opt-in, so anything else (unset, blank, non-numeric, ≤ 0) disables it.
 */
export function resolveCadenceIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[CADENCE_ENV_KEY]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export interface CreateEvolutionCadenceOptions {
  /** The evolution runtime. When absent (or it has no `evolutionCycle`), returns null. */
  evolutionRuntime?: EvolutionRuntime;
  /** Tick interval (ms). Floored by the core scheduler at its MIN_INTERVAL_MS. */
  intervalMs: number;
  /** Override the proposal engine (defaults to the shared governed engine). Tests. */
  engine?: ProposalEngine;
  /** Logger (defaults to the console logger). */
  logger?: Logger;
  /** Run a first cycle immediately on start (default false). */
  runImmediately?: boolean;
}

/**
 * Build an (un-started) {@link EvolutionScheduler} whose tick runs one evolution
 * cycle and persists its proposals as drafts. Returns `null` when no evolution
 * runtime / cycle is available (nothing to schedule). The caller decides when to
 * `start()` / `stop()` it (tied to the server lifecycle).
 */
export function createEvolutionCadence(
  options: CreateEvolutionCadenceOptions,
): EvolutionScheduler | null {
  const cycle = options.evolutionRuntime?.evolutionCycle;
  if (!cycle) return null;
  const engine = options.engine ?? getSharedProposalEngine();
  const logger = options.logger ?? consoleLogger;

  return createEvolutionScheduler({
    intervalMs: options.intervalMs,
    runImmediately: options.runImmediately ?? false,
    logger,
    tick: async () => {
      const result = await cycle.runCycle({ timestamp: new Date() });
      const summary = persistCycleProposalsAsDrafts({ proposals: result.proposals, engine });
      logger.info(
        `[EvolutionCadence] ran cycle → ${summary.created} new draft(s), ${summary.deduped} deduped ` +
          "(DRAFT-only; approval and graduation stay human-gated).",
      );
    },
  });
}
