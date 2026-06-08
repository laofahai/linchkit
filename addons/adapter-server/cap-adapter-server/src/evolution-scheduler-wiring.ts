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
  if (!Number.isFinite(n)) return null;
  // Floor BEFORE the positivity check so a sub-1ms fraction (e.g. "0.5" → 0)
  // leaves cadence OFF instead of enabling it at the scheduler's 1s floor.
  const floored = Math.floor(n);
  if (floored <= 0) return null;
  return floored;
}

/** Env var that scopes cadence to explicit tenant(s) (comma-separated). */
export const CADENCE_TENANTS_ENV_KEY = "EVOLUTION_CADENCE_TENANT_IDS";

/**
 * Resolve the tenant ids the cadence should run for, from a comma-separated env
 * var. Returns `[]` when unset/blank — meaning "run a single cycle in the default
 * (tenant-less) scope", which is correct for single-tenant / dev deployments.
 *
 * MULTI-TENANT deployments MUST set this: a tenant-less cycle would let
 * tenant-aware sensors read global/cross-tenant data and persist shared drafts.
 * Setting it makes the tick run once PER tenant with a scoped `SensorContext`.
 */
export function resolveCadenceTenantIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[CADENCE_TENANTS_ENV_KEY]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export interface CreateEvolutionCadenceOptions {
  /** The evolution runtime. When absent (or it has no `evolutionCycle`), returns null. */
  evolutionRuntime?: EvolutionRuntime;
  /** Tick interval (ms). Floored by the core scheduler at its MIN_INTERVAL_MS. */
  intervalMs: number;
  /**
   * Tenant ids to run the cycle for, each with a scoped `SensorContext`. Empty →
   * a single tenant-less (default-scope) cycle — correct for single-tenant / dev.
   * A multi-tenant deployment MUST pass explicit ids to avoid cross-tenant sensing.
   */
  tenantIds?: string[];
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
  // Empty → one tenant-less (default-scope) run; otherwise one scoped run per tenant.
  const tenantScopes: Array<string | undefined> =
    options.tenantIds && options.tenantIds.length > 0 ? options.tenantIds : [undefined];

  return createEvolutionScheduler({
    intervalMs: options.intervalMs,
    runImmediately: options.runImmediately ?? false,
    logger,
    tick: async () => {
      // Run the cycle once per configured tenant scope, each carrying its
      // `tenantId` in the SensorContext — the SAME contract the on-demand
      // `POST /api/evolution/run-cycle` route uses (it forwards the
      // CommandLayer-resolved tenant). NOTE: actual read isolation ultimately
      // depends on the runtime query helper + sensors honoring `ctx.tenantId`;
      // that enforcement is a runtime-level concern SHARED with the on-demand
      // path (tracked in #500), not something this cadence wiring can force.
      // Scopes are processed serially within the (non-overlapping) tick, and each
      // is isolated: one tenant's failing cycle must not starve the rest.
      for (const tenantId of tenantScopes) {
        try {
          const result = await cycle.runCycle({ timestamp: new Date(), tenantId });
          const summary = persistCycleProposalsAsDrafts({ proposals: result.proposals, engine });
          logger.info(
            `[EvolutionCadence] tenant=${tenantId ?? "(default)"} → ${summary.created} new draft(s), ` +
              `${summary.deduped} deduped (DRAFT-only; approval and graduation stay human-gated).`,
          );
        } catch (err) {
          logger.warn(
            `[EvolutionCadence] tenant=${tenantId ?? "(default)"} cycle failed: ` +
              `${err instanceof Error ? err.message : String(err)} — continuing with remaining tenants.`,
          );
        }
      }
    },
  });
}
