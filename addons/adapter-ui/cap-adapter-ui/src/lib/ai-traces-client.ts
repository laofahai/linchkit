/**
 * AI Traces client (Spec 69 — "Langfuse-class observability", issue #350).
 *
 * Thin typed wrapper over `GET /api/ai/traces` for the admin AI-traces page.
 * Split out of `api.ts` to keep that file within the file-size cap; reuses the
 * shared `getAuthHeaders` / `handleUnauthorized` helpers.
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

/** Error codes the trace endpoint returns for an authorization denial. */
const AI_TRACE_DENIED_CODES: ReadonlySet<string> = new Set([
  "AUTHZ_DENIED",
  "AI.READ_TRACES.BLOCKED",
]);

const DENIED_MESSAGE = "You don't have permission to view AI traces.";

/**
 * Fetch recent AI traces from `GET /api/ai/traces`.
 *
 * The endpoint returns `{ success: true, data: { traces, count } }` on success
 * and `{ success: false, error: { code, message } }` on an authorization
 * failure (HTTP 403). This helper maps an authz denial to a distinct
 * `{ kind: "denied" }` arm so the page can render a permission-specific message
 * — even when the 403 body is empty / non-JSON (e.g. from a proxy or gateway).
 *
 * The optional `fetchImpl` lets tests inject a stub `fetch` without leaking a
 * global mock across the batched suite (same DI pattern as `resolveSchemaIntent`).
 */
export async function fetchAITraces(
  options: {
    limit?: number;
    status?: AITraceStatus;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AITracesResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.status !== undefined) params.set("status", options.status);
  const qs = params.toString();
  const url = `/api/ai/traces${qs ? `?${qs}` : ""}`;

  let res: Response;
  try {
    res = await doFetch(url, { headers: getAuthHeaders(), signal: options.signal });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to load AI traces",
    };
  }
  // 401 → clears the token and redirects to /login (when auth is enabled).
  handleUnauthorized(res);

  let json: {
    success?: boolean;
    data?: { traces?: AITrace[]; count?: number };
    error?: { code?: string; message?: string };
  };
  try {
    json = await res.json();
  } catch {
    // Empty / non-JSON body (proxy, gateway, 204). A 403 is still a denial —
    // map it before falling back to a generic error so the friendly state shows.
    if (res.status === 403) return { kind: "denied", message: DENIED_MESSAGE };
    return { kind: "error", message: "AI traces endpoint returned an invalid response" };
  }

  if (json.success && json.data) {
    return {
      kind: "ok",
      traces: json.data.traces ?? [],
      count: json.data.count ?? json.data.traces?.length ?? 0,
    };
  }

  const code = json.error?.code ?? "";
  const message = json.error?.message ?? "Failed to load AI traces";
  // Permission denied (authenticated): 403 status, or the canonical authz code.
  if (res.status === 403 || AI_TRACE_DENIED_CODES.has(code)) {
    return { kind: "denied", message: message || DENIED_MESSAGE };
  }
  return { kind: "error", message };
}
