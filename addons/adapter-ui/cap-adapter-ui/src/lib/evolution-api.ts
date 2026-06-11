/**
 * API client for the autonomous-evolution cadence loop's read-only surfaces.
 *
 * Today this is the scheduler-status heartbeat (`GET /api/evolution/scheduler-status`).
 * The wire types are mirrored locally — the UI never imports the server/core
 * runtime — and every call returns a discriminated result so the caller renders
 * each outcome (configured/unconfigured/denied/error) distinctly instead of
 * catching thrown errors. Mirrors the conventions in `lib/proposal-api.ts`.
 */

import { getDevRoleHeaders } from "./dev-role";

// ── Auth header helper (reuse from api.ts / proposal-api.ts pattern) ──────

function getAuthHeaders(): Record<string, string> {
  // Guard `localStorage` access: it is absent in non-browser contexts (SSR,
  // loaders, some test runners), where touching it throws a ReferenceError.
  if (typeof localStorage === "undefined") {
    return {};
  }
  const token = localStorage.getItem("linchkit:token");
  // Dev-only role switching header — empty unless explicitly chosen.
  const devRoleHeaders = getDevRoleHeaders();
  if (token) {
    return { Authorization: `Bearer ${token}`, ...devRoleHeaders };
  }
  return { ...devRoleHeaders };
}

// ── Wire type ──────────────────────────────────────────────

/**
 * Self-contained wire shape of `GET /api/evolution/scheduler-status`'s `data`,
 * mirroring the backend contract (a sibling PR owns the endpoint). Discriminated
 * on `configured`:
 *
 *  - `{ configured: false }` — cadence disabled (no scheduler wired).
 *  - `{ configured: true, ... }` — scheduler wired; `running` reflects whether
 *    the cadence loop is currently ticking. `Date` fields arrive as ISO strings
 *    (serialized server-side) so consumers never call `Date` methods blindly.
 *
 * NOT imported from `@linchkit/core` on purpose — the UI keeps its own mirror.
 */
export type SchedulerStatus =
  | { configured: false }
  | {
      configured: true;
      running: boolean;
      intervalMs: number;
      ticksStarted: number;
      ticksCompleted: number;
      lastTickStartedAt: string | null;
      lastTickCompletedAt: string | null;
      lastTickDurationMs: number | null;
      lastError: string | null;
      consecutiveErrors: number;
    };

/**
 * Discriminated result of `fetchSchedulerStatus`.
 *
 *  - `{ kind: "ok" }` — 200; `status` is the discriminated `SchedulerStatus`
 *    (which itself distinguishes configured vs. unconfigured).
 *  - `{ kind: "denied" }` — 401 / 403 (AUTHZ_DENIED).
 *  - `{ kind: "error" }` — 503 (command layer not configured) / other non-2xx /
 *    transport error / invalid JSON. `message` carries a user-friendly reason.
 */
export type SchedulerStatusResult =
  | { kind: "ok"; status: SchedulerStatus }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/** Shape of the `scheduler-status` JSON envelope. Local mirror of the wire contract. */
interface SchedulerStatusWireResponse {
  success?: boolean;
  data?: Partial<{
    configured: boolean;
    running: boolean;
    intervalMs: number;
    ticksStarted: number;
    ticksCompleted: number;
    lastTickStartedAt: string | null;
    lastTickCompletedAt: string | null;
    lastTickDurationMs: number | null;
    lastError: string | null;
    consecutiveErrors: number;
  }>;
  error?: { code?: string; message?: string };
}

/** Best-effort extraction of the structured error message from a JSON body. */
async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message;
  } catch {
    // Body was empty / non-JSON — caller falls back to its own message.
    return undefined;
  }
}

/** Normalize a possibly-partial wire `data` block into a typed `SchedulerStatus`. */
function toSchedulerStatus(data: SchedulerStatusWireResponse["data"]): SchedulerStatus {
  if (data?.configured !== true) {
    return { configured: false };
  }
  return {
    configured: true,
    running: data.running ?? false,
    intervalMs: data.intervalMs ?? 0,
    ticksStarted: data.ticksStarted ?? 0,
    ticksCompleted: data.ticksCompleted ?? 0,
    lastTickStartedAt: data.lastTickStartedAt ?? null,
    lastTickCompletedAt: data.lastTickCompletedAt ?? null,
    lastTickDurationMs: data.lastTickDurationMs ?? null,
    lastError: data.lastError ?? null,
    consecutiveErrors: data.consecutiveErrors ?? 0,
  };
}

// ── API call ───────────────────────────────────────────────

/**
 * Read the cadence loop's scheduler status (read-only — never mutates).
 *
 * Wire contract (GET /api/evolution/scheduler-status):
 *   200 → { success: true, data: { configured: false } }
 *       | { success: true, data: { configured: true, running, intervalMs, ... } }
 *   401/403 → AUTHZ_DENIED (mapped to `denied`)
 *   503 → command layer not configured (mapped to `error`)
 *   other non-2xx / transport error / invalid JSON → `error`
 *
 * The optional `fetchImpl` lets tests inject a stub `fetch` without leaking a
 * global mock across the batched suite; `signal` allows the caller to cancel an
 * in-flight poll on unmount.
 */
export async function fetchSchedulerStatus(
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SchedulerStatusResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch("/api/evolution/scheduler-status", {
      headers: getAuthHeaders(),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to load scheduler status",
    };
  }

  // 401 / 403 — access denied.
  if (res.status === 401 || res.status === 403) {
    return { kind: "denied" };
  }

  // 503 (command layer not configured) / other non-2xx — surface an error.
  if (!res.ok) {
    return {
      kind: "error",
      message: (await readErrorMessage(res)) ?? "Failed to load scheduler status",
    };
  }

  let json: SchedulerStatusWireResponse;
  try {
    json = (await res.json()) as SchedulerStatusWireResponse;
  } catch {
    return { kind: "error", message: "Scheduler status returned an invalid response" };
  }

  // A `null` body is valid JSON but not a usable envelope — guard before reading
  // `.data` so this can't throw an unhandled TypeError outside the catch above.
  if (!json || typeof json !== "object") {
    return { kind: "error", message: "Scheduler status returned an invalid response" };
  }

  return { kind: "ok", status: toSchedulerStatus(json.data) };
}
