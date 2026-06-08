/**
 * Evolution scheduler status REST endpoint (Spec 55 §7).
 *
 * GET /api/evolution/scheduler-status
 *
 * Read-only liveness surface for the OPT-IN autonomous evolution cadence loop:
 * lets a human operator see whether the timer is alive (running, ticking,
 * succeeding, or stuck erroring) WITHOUT any side effect. The cadence itself is
 * built in `evolution-scheduler-wiring.ts` and only produces governance DRAFTS —
 * this endpoint never mutates anything; it only reports `scheduler.getStatus()`.
 *
 * Hard safety boundary (repo principle "AI Never Modifies Production Directly"):
 *  - This route is strictly READ-ONLY. It never starts/stops the scheduler, runs
 *    a cycle, or persists anything.
 *
 * Pipeline: like `POST /api/evolution/run-cycle`, the request first passes
 * through CommandLayer with `skipActionSlots = true` so auth / permission /
 * tenant slots still run (the permission slot is NEVER skipped) while the
 * action-specific slots are bypassed. The synthetic command name
 * `"evolution.scheduler_status"` exists only for metrics/tracing labels; the
 * authoritative permission target is carried in `meta.evolution`.
 *
 * Graceful degradation: when no scheduler is wired (cadence disabled via env),
 * the endpoint returns 200 `{ configured: false }` rather than an error — the
 * operator's question ("is the loop alive?") has a definitive answer ("there is
 * no loop"), so this is a successful read, not a failure.
 */

import type { EvolutionScheduler, EvolutionSchedulerStatus } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { resolveActor, resolveStatusCode, serviceUnavailable } from "./shared";

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

/** Synthetic command name for the scheduler-status dispatch (metrics/tracing only). */
export const SCHEDULER_STATUS_COMMAND_NAME = "evolution.scheduler_status";

/** Wire-format scheduler status — Date fields serialized as ISO strings (or null). */
export interface SchedulerStatusWire {
  running: boolean;
  intervalMs: number;
  ticksStarted: number;
  ticksCompleted: number;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
  consecutiveErrors: number;
}

/** Successful response when a scheduler is wired. */
export interface SchedulerStatusConfiguredResponse {
  success: true;
  data: { configured: true } & SchedulerStatusWire;
}

/** Successful response when cadence is disabled (no scheduler wired). */
export interface SchedulerStatusUnconfiguredResponse {
  success: true;
  data: { configured: false };
}

/** Convert the core status snapshot to its JSON wire form (ISO date strings). */
function toWire(status: EvolutionSchedulerStatus): SchedulerStatusWire {
  return {
    running: status.running,
    intervalMs: status.intervalMs,
    ticksStarted: status.ticksStarted,
    ticksCompleted: status.ticksCompleted,
    lastTickStartedAt: status.lastTickStartedAt ? status.lastTickStartedAt.toISOString() : null,
    lastTickCompletedAt: status.lastTickCompletedAt
      ? status.lastTickCompletedAt.toISOString()
      : null,
    lastTickDurationMs: status.lastTickDurationMs,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors,
  };
}

/**
 * Mount `GET /api/evolution/scheduler-status` onto the given Elysia app.
 *
 * Behavior summary:
 *   503 — command layer not configured (cannot run the permission slot).
 *   401/403 — caller failed the CommandLayer permission slot (canonical envelope).
 *   200 `{ configured: false }` — no scheduler wired (cadence disabled).
 *   200 `{ configured: true, ...status }` — scheduler wired; read-only snapshot.
 */
export function mountEvolutionStatusRoutes(app: Elysia, options: ServerOptions): void {
  const { commandLayer } = options;
  const scheduler: EvolutionScheduler | undefined = options.evolutionScheduler;

  app.get("/api/evolution/scheduler-status", async ({ set, request }) => {
    if (!commandLayer) {
      // The permission slot lives in CommandLayer; without it we cannot
      // authorize the read, so fail closed rather than skipping the slot.
      return serviceUnavailable(
        set,
        "Command layer is not configured — cannot authorize the evolution scheduler status read.",
      );
    }

    // ── Permission slot (CommandLayer, skipActionSlots) ────────────────
    // Run auth / permission / tenant BEFORE reporting anything — an unauthorized
    // caller must not learn whether cadence is even configured.
    const actor = await resolveActor(request, options.resolveRequestActor);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
    const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

    const commandResult = await commandLayer.execute({
      command: SCHEDULER_STATUS_COMMAND_NAME,
      input: {},
      actor,
      channel: "http",
      headers,
      traceId: incomingTraceId,
      meta: {
        // Permission middleware gates on this target rather than an action named
        // "scheduler_status". Mirrors the run-cycle route's `meta.evolution`.
        evolution: { operation: "scheduler_status" },
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
      const middlewareMessage =
        (errData?.error as string) ?? "Evolution scheduler status read blocked";
      const middlewareCode = (errData?.code as string) ?? "EVOLUTION.SCHEDULER_STATUS.BLOCKED";
      return { success: false, error: { code: middlewareCode, message: middlewareMessage } };
    }

    // ── Report (read-only) ─────────────────────────────────────────────
    // No scheduler wired → cadence is disabled in this deployment. That's a
    // definitive answer to "is the loop alive?" ("there is no loop"), so it's a
    // successful 200 read rather than an error.
    if (!scheduler) {
      const response: SchedulerStatusUnconfiguredResponse = {
        success: true,
        data: { configured: false },
      };
      return response;
    }

    const response: SchedulerStatusConfiguredResponse = {
      success: true,
      data: { configured: true, ...toWire(scheduler.getStatus()) },
    };
    return response;
  });
}
