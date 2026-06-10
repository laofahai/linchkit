/**
 * AI trace admin read endpoint (Spec 69 Phase 3 wave 2).
 *
 * GET /api/ai/traces — recent AI traces from the active {@link getAITraceSink}.
 *
 * This is the read side of the trace persistence wired at boot
 * (`wire-ai-trace-sink.ts`): the AI instrumentation records every generation into
 * the registered sink, and this endpoint surfaces the rolled-up parent traces for
 * an operator / admin UI.
 *
 * Permission (CLAUDE.md: "All API endpoints go through CommandLayer (permission slot
 * never skipped)"): like the onchange (Spec 64) and evolution run-cycle (Spec 55 §7)
 * routes, the request first passes through CommandLayer with `skipActionSlots = true`
 * so auth / permission / tenant slots still run while the action-specific slots are
 * bypassed (there is no write action). The authoritative permission target is carried
 * in `meta.aiObservability = { operation: "read_traces" }`, which the permission
 * middleware gates on `grant.ai.actions.read_traces` (companion to `meta.evolution`).
 *
 * Tenant scoping: the tenant the CommandLayer tenant slot resolved is forwarded into
 * the trace query so a tenant-scoped operator never sees another tenant's traces. An
 * unscoped (admin) caller sees all tenants. Query params (`limit`, `tenantId`,
 * `scenario`, `origin`, `status`, `model`) are validated/clamped; `limit` has a sane
 * default and hard cap. The body is never read — this is a GET.
 *
 * Reads through the sink's DURABLE async query when available (the Drizzle store
 * exposes `queryTracesPersisted`, serving history that survived a restart) and falls
 * back to the synchronous process-local hot view (`queryTraces`) otherwise.
 */

import type { AITrace, AITraceOrigin, AITraceQueryOptions, AITraceStatus } from "@linchkit/core";
import { getAITraceSink } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { badRequest, resolveActor, resolveStatusCode, serviceUnavailable } from "./shared";

/**
 * Canonical authorization-denied envelope — every 401/403 path returns the SAME
 * payload so the response text cannot be used as a side channel.
 */
const AUTHZ_DENIED_BODY = {
  success: false as const,
  error: {
    code: "AUTHZ_DENIED",
    message: "Access denied",
  },
} as const;

/** Synthetic command name for the trace-read dispatch (metrics/tracing only). */
export const READ_TRACES_COMMAND_NAME = "ai.read_traces";

/** Permission operation gated as `grant.ai.actions.<operation>`. */
export const READ_TRACES_OPERATION = "read_traces";

/** Default page size when `?limit=` is absent. */
const DEFAULT_TRACE_LIMIT = 50;
/** Hard cap on `?limit=` — protects the durable query from unbounded scans. */
const MAX_TRACE_LIMIT = 500;

const VALID_ORIGINS: ReadonlySet<string> = new Set<AITraceOrigin>(["production", "eval"]);
const VALID_STATUSES: ReadonlySet<string> = new Set<AITraceStatus>(["ok", "error", "partial"]);

/**
 * A sink that additionally exposes the async durable trace query (the Drizzle
 * store). Structural — we don't import the concrete class so cap-adapter-server
 * keeps only a lazy dependency on cap-ai-provider.
 */
interface PersistedTraceReader {
  queryTracesPersisted(options?: AITraceQueryOptions): Promise<AITrace[]>;
}

function hasPersistedReader(sink: unknown): sink is PersistedTraceReader {
  return (
    typeof sink === "object" &&
    sink !== null &&
    typeof (sink as { queryTracesPersisted?: unknown }).queryTracesPersisted === "function"
  );
}

/**
 * Mount `GET /api/ai/traces` onto the given Elysia app.
 *
 * Behavior summary:
 *   400 — invalid `?limit=` / `?origin=` / `?status=` query param.
 *   503 — command layer not configured (cannot run the permission slot, fail closed).
 *   401/403 — caller failed the CommandLayer permission slot (canonical envelope).
 *   200 — `{ success: true, data: { traces, count } }` (most-recent-first).
 */
export function mountAITracesRoutes(app: Elysia, options: ServerOptions): void {
  const { commandLayer } = options;

  app.get("/api/ai/traces", async ({ query, set, request }) => {
    if (!commandLayer) {
      // The permission slot lives in CommandLayer; without it we cannot authorize
      // the read, so fail closed rather than skipping the slot.
      return serviceUnavailable(
        set,
        "Command layer is not configured — cannot authorize the AI trace read.",
      );
    }

    // ── Validate + clamp query params BEFORE auth-touching work ──────────
    // (cheap input validation; nothing is leaked because we 400 the same way
    // regardless of authorization — the values aren't tenant data.)
    let limit = DEFAULT_TRACE_LIMIT;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        return badRequest(set, "Invalid 'limit' — must be a non-negative integer.");
      }
      limit = Math.min(parsed, MAX_TRACE_LIMIT);
    }

    const origin = query.origin as string | undefined;
    if (origin !== undefined && !VALID_ORIGINS.has(origin)) {
      return badRequest(set, "Invalid 'origin' — must be 'production' or 'eval'.");
    }
    const status = query.status as string | undefined;
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return badRequest(set, "Invalid 'status' — must be 'ok', 'error', or 'partial'.");
    }

    // ── Permission slot (CommandLayer, skipActionSlots) ──────────────────
    // Run auth / permission / tenant BEFORE touching the sink so an unauthorized
    // caller learns nothing about which traces exist.
    const actor = await resolveActor(request, options.resolveRequestActor);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
    const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

    const commandResult = await commandLayer.execute({
      command: READ_TRACES_COMMAND_NAME,
      input: {},
      actor,
      channel: "http",
      headers,
      traceId: incomingTraceId,
      meta: {
        // Permission middleware gates on `grant.ai.actions.read_traces` rather
        // than an action named "read_traces". Mirrors the run-cycle route's
        // `meta.evolution` convention (Spec 69 P3 / companion to #527/#528).
        aiObservability: { operation: READ_TRACES_OPERATION },
      },
      skipActionSlots: true,
    });

    if (!commandResult.success) {
      const statusCode = resolveStatusCode(commandResult);
      set.status = statusCode;
      if (statusCode === 401 || statusCode === 403) {
        return AUTHZ_DENIED_BODY;
      }
      const errData = commandResult.data as Record<string, unknown> | undefined;
      const middlewareMessage = (errData?.error as string) ?? "AI trace read blocked";
      const middlewareCode = (errData?.code as string) ?? "AI.READ_TRACES.BLOCKED";
      return { success: false, error: { code: middlewareCode, message: middlewareMessage } };
    }

    // ── Resolve tenant scope from the tenant slot ────────────────────────
    // The skipActionSlots dispatch returns the tenant the tenant slot resolved on
    // `data.tenantId`. When the caller is unscoped (admin) it is undefined → all
    // tenants. A `?tenantId=` query param can only NARROW within the resolved
    // scope: when the tenant slot pinned a tenant, that pin always wins so a
    // scoped operator can never read across tenants by passing a foreign id.
    const resolvedTenantId = (commandResult.data as { tenantId?: string } | undefined)?.tenantId;
    const queryTenantParam =
      typeof query.tenantId === "string" && query.tenantId.length > 0 ? query.tenantId : undefined;
    const tenantId = resolvedTenantId ?? queryTenantParam;

    // ── Query the sink ───────────────────────────────────────────────────
    const queryOptions: AITraceQueryOptions = {
      limit,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(origin !== undefined ? { origin: origin as AITraceOrigin } : {}),
      ...(status !== undefined ? { status: status as AITraceStatus } : {}),
      ...(typeof query.scenario === "string" && query.scenario.length > 0
        ? { scenario: query.scenario }
        : {}),
      ...(typeof query.model === "string" && query.model.length > 0 ? { model: query.model } : {}),
    };

    try {
      const sink = getAITraceSink();
      // Prefer the durable async query (Drizzle store) so the endpoint serves
      // history that survived a restart; fall back to the sync process-local
      // hot view for the in-memory / noop sinks.
      const traces = hasPersistedReader(sink)
        ? await sink.queryTracesPersisted(queryOptions)
        : sink.queryTraces(queryOptions);
      return { success: true, data: { traces, count: traces.length } };
    } catch (err) {
      const message =
        process.env.NODE_ENV === "production"
          ? "Failed to query AI traces."
          : err instanceof Error
            ? err.message
            : String(err);
      set.status = 500;
      return { success: false, error: { message } };
    }
  });
}
