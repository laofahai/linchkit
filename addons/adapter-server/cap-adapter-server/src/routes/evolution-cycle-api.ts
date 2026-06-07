/**
 * Evolution cycle trigger REST endpoint (Spec 55 §7).
 *
 * POST /api/evolution/run-cycle
 *
 * Runs ONE on-demand evolution cycle (`evolutionRuntime.evolutionCycle.runCycle`)
 * and persists each proposal it produces as a governance `draft` in the shared
 * {@link getSharedProposalEngine} engine — so cycle output enters the existing
 * human review pipeline (`GET /api/proposals`) instead of evaporating as
 * transient cycle data.
 *
 * Hard safety boundary (repo principle "AI Never Modifies Production Directly"):
 *  - Proposals are persisted ONLY as `draft`. This route NEVER submits,
 *    validates, approves, commits, deploys, or graduates anything. The
 *    human review → approval pipeline stays untouched.
 *  - The route is ON-DEMAND only. There is NO scheduler / cron / timer that
 *    auto-runs the cycle — cadence is a deferred product decision.
 *  - No file-write / git / PR path is wired here.
 *
 * Pipeline: like the onchange endpoint (Spec 64), the request first passes
 * through CommandLayer with `skipActionSlots = true` so auth / permission /
 * tenant slots still run (the permission slot is NEVER skipped) while the
 * action-specific slots are bypassed. The synthetic command name
 * `"evolution.run_cycle"` exists only for metrics/tracing labels; the
 * authoritative permission target is carried in `meta.evolution`.
 */

import { type EvolutionRuntime, persistCycleProposalsAsDrafts } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { getSharedProposalEngine } from "../proposal-api";
import type { ServerOptions } from "../server";
import { resolveActor, resolveStatusCode, serverError, serviceUnavailable } from "./shared";

/**
 * Canonical authorization-denied envelope — every 401/403 path returns the
 * SAME payload so the response text cannot be used as a side channel.
 */
const AUTHZ_DENIED_BODY = {
  success: false as const,
  error: {
    code: "AUTHZ_DENIED",
    message: "Access denied",
  },
} as const;

/** Synthetic command name for the run-cycle dispatch (metrics/tracing only). */
export const RUN_CYCLE_COMMAND_NAME = "evolution.run_cycle";

/** Wire-format response for a successful run-cycle invocation. */
export interface RunCycleResponse {
  success: true;
  data: {
    /** Number of cycle proposals newly persisted as `draft`. */
    created: number;
    /** Number of cycle proposals skipped as duplicates of an already-pending draft. */
    deduped: number;
    /** Total cycle proposals considered (`created + deduped`). */
    total: number;
    /** Engine ids of the drafts created this run (all `draft` status). */
    createdIds: string[];
  };
}

/**
 * Mount `POST /api/evolution/run-cycle` onto the given Elysia app.
 *
 * Behavior summary:
 *   501 — evolution runtime not configured (graceful degradation).
 *   503 — command layer not configured (cannot run the permission slot).
 *   401/403 — caller failed the CommandLayer permission slot (canonical envelope).
 *   500 — unexpected throw while running the cycle / persisting drafts.
 *   200 — cycle ran; returns `{ created, deduped, total, createdIds }`.
 */
export function mountEvolutionCycleRoutes(app: Elysia, options: ServerOptions): void {
  const { commandLayer } = options;
  const evolutionRuntime: EvolutionRuntime | undefined = options.evolutionRuntime;

  app.post("/api/evolution/run-cycle", async ({ set, request }) => {
    if (!evolutionRuntime) {
      // 501 — feature not wired in this deployment. (No cycle to run.)
      return serviceUnavailable(
        set,
        "Evolution runtime is not configured — on-demand cycle execution is unavailable.",
        501,
      );
    }
    if (!commandLayer) {
      // The permission slot lives in CommandLayer; without it we cannot
      // authorize a mutation, so fail closed rather than skipping the slot.
      return serviceUnavailable(
        set,
        "Command layer is not configured — cannot authorize the evolution cycle trigger.",
      );
    }

    // ── Permission slot (CommandLayer, skipActionSlots) ────────────────
    // Run auth / permission / tenant BEFORE touching the evolution runtime so
    // an unauthorized caller learns nothing beyond "access denied".
    const actor = await resolveActor(request, options.resolveRequestActor);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
    const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

    const commandResult = await commandLayer.execute({
      command: RUN_CYCLE_COMMAND_NAME,
      input: {},
      actor,
      channel: "http",
      headers,
      traceId: incomingTraceId,
      meta: {
        // Permission middleware gates on this target rather than an action named
        // "run_cycle". Mirrors the onchange route's `meta.onchange` convention.
        evolution: { operation: "run_cycle" },
      },
      skipActionSlots: true,
    });

    if (!commandResult.success) {
      const status = resolveStatusCode(commandResult);
      set.status = status;
      if (status === 401 || status === 403) {
        return AUTHZ_DENIED_BODY;
      }
      const errData = commandResult.data as Record<string, unknown> | undefined;
      const middlewareMessage = (errData?.error as string) ?? "Evolution cycle trigger blocked";
      const middlewareCode = (errData?.code as string) ?? "EVOLUTION.RUN_CYCLE.BLOCKED";
      return { success: false, error: { code: middlewareCode, message: middlewareMessage } };
    }

    // ── Run the cycle + persist drafts ─────────────────────────────────
    // Propagate the tenant the CommandLayer tenant slot resolved so tenant-aware
    // sensors scope their observations to the authorized tenant (passing only a
    // timestamp would make them read global/default data, defeating that slot).
    // `query` is intentionally omitted — the runtime injects its configured
    // default query for any context that omits one.
    try {
      // The skipActionSlots dispatch returns the tenant the tenant slot resolved
      // on `data.tenantId` (CommandLayer's synthetic non-action result).
      const resolvedTenantId = (commandResult.data as { tenantId?: string } | undefined)?.tenantId;
      const result = await evolutionRuntime.evolutionCycle.runCycle({
        timestamp: new Date(),
        tenantId: resolvedTenantId,
      });
      // Persist each cycle proposal as a `draft` in the shared governance
      // engine, deduped against the already-pending set. NEVER submitted /
      // approved here — the helper only calls createProposal (draft status).
      const summary = persistCycleProposalsAsDrafts({
        proposals: result.proposals,
        engine: getSharedProposalEngine(),
      });
      const response: RunCycleResponse = {
        success: true,
        data: {
          created: summary.created,
          deduped: summary.deduped,
          total: summary.total,
          createdIds: summary.createdIds,
        },
      };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Evolution cycle execution failed";
      return serverError(set, message);
    }
  });
}
