/**
 * Trace-detail panel state helpers (pure, render-free).
 *
 * The detail panel stores its fetched generations TOGETHER with the traceId
 * they belong to, and only surfaces them when that id matches the currently
 * selected trace. This closes the one-frame stale window when switching
 * trace A → B: before the fetch effect for B commits, the stored result still
 * belongs to A, so the resolver returns null and the panel renders the
 * loading skeleton instead of A's cards under B's header.
 */

import type { AITraceGenerationsResult } from "./ai-traces-client";

/** A generations result tagged with the traceId it was fetched for. */
export interface StoredGenerationsResult {
  traceId: string;
  result: AITraceGenerationsResult;
}

/**
 * Resolve the result to render for the currently selected trace.
 *
 * Returns the stored result only when it belongs to `traceId`; returns null
 * when the panel is closed (`traceId` undefined), nothing is stored yet, or
 * the stored result belongs to a previously selected trace.
 */
export function resolveStoredResult(
  stored: StoredGenerationsResult | null,
  traceId: string | undefined,
): AITraceGenerationsResult | null {
  if (!stored || !traceId || stored.traceId !== traceId) return null;
  return stored.result;
}
