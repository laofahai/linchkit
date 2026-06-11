/**
 * AI Traces client (Spec 69 — "Langfuse-class observability", issue #350).
 *
 * Thin typed wrapper over `GET /api/ai/traces` (roll-up list) and
 * `GET /api/ai/traces/:id/generations` (per-trace drill-down) for the admin
 * AI-traces page. Split out of `api.ts` to keep that file within the
 * file-size cap; reuses the shared `getAuthHeaders` / `handleUnauthorized`
 * helpers.
 */

import { getAuthHeaders, handleUnauthorized } from "./api";

/** Origin discriminator for an AI trace (mirrors `@linchkit/core` AITrace). */
export type AITraceOrigin = "production" | "eval";

/** Roll-up status for an AI trace. */
export type AITraceStatus = "ok" | "error" | "partial";

/**
 * A single rolled-up AI trace as returned by `GET /api/ai/traces`.
 *
 * Local mirror of the `@linchkit/core` `AITrace` type — the UI must not import
 * from `@linchkit/core/server` (module boundary), so this shape is kept in sync
 * with the server's wire response. `startedAt` / `endedAt` are epoch milliseconds.
 */
export interface AITrace {
  traceId: string;
  name: string;
  scenario?: string;
  origin: AITraceOrigin;
  status: AITraceStatus;
  startedAt: number;
  endedAt?: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  tenantId?: string;
  actorId?: string;
  tags?: string[];
}

/** One redacted prompt message inside an {@link AIGeneration}. */
export interface AITraceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * A single AI generation (one model call) as returned by
 * `GET /api/ai/traces/:id/generations`.
 *
 * Local mirror of the `@linchkit/core` `AIGeneration` wire shape (same module
 * boundary as {@link AITrace}). `messages` / `completion` arrive already
 * redacted by the server — the UI displays them as-is, never un-masks.
 * `startedAt` / `endedAt` are epoch milliseconds; `completion` is empty for
 * streaming calls.
 */
export interface AIGeneration {
  id: string;
  traceId: string;
  model: string;
  provider: string;
  /** Redacted prompt messages. */
  messages: AITraceMessage[];
  /** Redacted completion (empty for streaming). */
  completion: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  latencyMs: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  fallbackUsed?: string;
  cached?: boolean;
  partial?: boolean;
  status: AITraceStatus;
  error?: string;
  startedAt: number;
  endedAt: number;
}

/**
 * Discriminated result of `fetchAITraces` so the caller can distinguish a
 * successful read from an authorization denial (which needs a friendlier
 * "no permission" UI rather than a raw error banner).
 *
 *  - `{ kind: "ok" }` — traces returned (most-recent-first).
 *  - `{ kind: "denied" }` — authenticated but the permission slot rejected the read (403).
 *  - `{ kind: "error" }` — a transport / server error; surface `message`.
 *
 * Note: a 401 (unauthenticated) is handled upstream by `handleUnauthorized`,
 * which clears the token and redirects to `/login` — so it never reaches the
 * `denied` arm here.
 */
export type AITracesResult =
  | { kind: "ok"; traces: AITrace[]; count: number }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

/** Discriminated result of `fetchTraceGenerations` (same arms as {@link AITracesResult}). */
export type AITraceGenerationsResult =
  | { kind: "ok"; generations: AIGeneration[]; count: number }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

/**
 * Error codes the trace endpoints return for an authorization denial — shared
 * by the list and the per-trace generations fetchers (single source of truth).
 */
export const AI_TRACE_DENIED_CODES: ReadonlySet<string> = new Set([
  "AUTHZ_DENIED",
  "AI.READ_TRACES.BLOCKED",
]);

const DENIED_MESSAGE = "You don't have permission to view AI traces.";

/** Standard `{ success, data, error }` envelope both trace endpoints return. */
interface TraceApiEnvelope<TData> {
  success?: boolean;
  data?: TData;
  error?: { code?: string; message?: string };
}

/**
 * Shared request core for both trace endpoints: performs the authenticated
 * fetch, routes a 401 through `handleUnauthorized`, and maps the response
 * envelope to a discriminated outcome. An authz denial (HTTP 403, a canonical
 * denied code, or a non-JSON 403 body from a proxy/gateway) becomes
 * `{ kind: "denied" }`; everything else failing becomes `{ kind: "error" }`.
 *
 * The optional `fetchImpl` lets tests inject a stub `fetch` without leaking a
 * global mock across the batched suite (same DI pattern as `resolveSchemaIntent`).
 */
async function requestTraceApi<TData>(options: {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Fallback failure message when the response carries no error message. */
  fallbackMessage: string;
}): Promise<
  | { kind: "ok"; data: TData }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
> {
  const doFetch = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(options.url, { headers: getAuthHeaders(), signal: options.signal });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : options.fallbackMessage,
    };
  }
  // 401 → clears the token and redirects to /login (when auth is enabled).
  handleUnauthorized(res);

  let json: TraceApiEnvelope<TData>;
  try {
    json = await res.json();
  } catch {
    // Empty / non-JSON body (proxy, gateway, 204). A 403 is still a denial —
    // map it before falling back to a generic error so the friendly state shows.
    if (res.status === 403) return { kind: "denied", message: DENIED_MESSAGE };
    return { kind: "error", message: options.fallbackMessage };
  }

  if (json.success && json.data) {
    return { kind: "ok", data: json.data };
  }

  const code = json.error?.code ?? "";
  const message = json.error?.message ?? options.fallbackMessage;
  // Permission denied (authenticated): 403 status, or the canonical authz code.
  if (res.status === 403 || AI_TRACE_DENIED_CODES.has(code)) {
    return { kind: "denied", message: message || DENIED_MESSAGE };
  }
  return { kind: "error", message };
}

/**
 * Fetch recent AI traces from `GET /api/ai/traces`.
 *
 * The endpoint returns `{ success: true, data: { traces, count } }` on success
 * and `{ success: false, error: { code, message } }` on an authorization
 * failure (HTTP 403) — see {@link requestTraceApi} for the envelope mapping.
 */
export async function fetchAITraces(
  options: {
    limit?: number;
    status?: AITraceStatus;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AITracesResult> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.status !== undefined) params.set("status", options.status);
  const qs = params.toString();
  const url = `/api/ai/traces${qs ? `?${qs}` : ""}`;

  const outcome = await requestTraceApi<{ traces?: AITrace[]; count?: number }>({
    url,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    fallbackMessage: "Failed to load AI traces",
  });
  if (outcome.kind !== "ok") return outcome;
  return {
    kind: "ok",
    traces: outcome.data.traces ?? [],
    count: outcome.data.count ?? outcome.data.traces?.length ?? 0,
  };
}

/**
 * Fetch the per-call generations of one trace from
 * `GET /api/ai/traces/:id/generations`.
 *
 * The endpoint returns `{ success: true, data: { generations, count } }` on
 * success and the same denial/error envelope as the list endpoint — see
 * {@link requestTraceApi}. Content (`messages` / `completion`) is already
 * redacted server-side and is displayed as-is.
 */
export async function fetchTraceGenerations(options: {
  traceId: string;
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<AITraceGenerationsResult> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  const url = `/api/ai/traces/${encodeURIComponent(options.traceId)}/generations${qs ? `?${qs}` : ""}`;

  const outcome = await requestTraceApi<{ generations?: AIGeneration[]; count?: number }>({
    url,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    fallbackMessage: "Failed to load trace generations",
  });
  if (outcome.kind !== "ok") return outcome;
  return {
    kind: "ok",
    generations: outcome.data.generations ?? [],
    count: outcome.data.count ?? outcome.data.generations?.length ?? 0,
  };
}
