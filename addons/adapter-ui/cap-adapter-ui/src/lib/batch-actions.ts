/**
 * Batch action client (Spec 16 §3.1, Spec 04 §8).
 *
 * Wraps `POST /api/actions/batch` with:
 *  - Client-side chunking to honor the 500-item server cap (MAX_BATCH_SIZE).
 *  - Sequential chunk execution so server backpressure is preserved.
 *  - Result aggregation across chunks into one `BatchActionsResult` shape.
 *
 * Errors thrown by the transport (network/HTTP) are surfaced into the
 * `failed` list so callers can render them inline rather than catching at
 * the call site.
 */

import type {
  BatchActionItem,
  BatchActionsResult,
  BatchTransactionStrategy,
} from "@linchkit/core/types";
import { getTenantHeaders } from "./tenant";

/**
 * Maximum items per `/api/actions/batch` call. Mirrors `MAX_BATCH_SIZE` in
 * `@linchkit/core` (`packages/core/src/engine/batch-action-engine.ts`). The
 * UI chunks larger selections client-side so users never see the server
 * cap as a failure.
 */
export const BATCH_CHUNK_SIZE = 500;

/** Pure chunking helper. Splits an array into evenly-sized contiguous slices. */
export function chunkIds(ids: string[], size: number = BATCH_CHUNK_SIZE): string[][] {
  if (size <= 0) {
    throw new Error("chunkIds: size must be > 0");
  }
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

/**
 * Aggregate per-chunk batch results into a single result envelope.
 *
 * - `succeeded` / `failed` / `rolledBack` are concatenated.
 * - `summary` counts are summed.
 * - `success` is `true` iff every chunk succeeded.
 * - `parentExecutionId` is taken from the first chunk (each chunk is
 *   independently a parent batch on the server; we surface the first for
 *   correlation in toasts/logs).
 * - `strategy` is taken from the first chunk (every chunk requested the same).
 */
export function aggregateBatchResults(results: BatchActionsResult[]): BatchActionsResult {
  if (results.length === 0) {
    return {
      success: true,
      parentExecutionId: "",
      strategy: "partial",
      succeeded: [],
      failed: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    };
  }
  const first = results[0] as BatchActionsResult;
  const succeeded = results.flatMap((r) => r.succeeded);
  const failed = results.flatMap((r) => r.failed);
  const rolledBack = results.flatMap((r) => r.rolledBack ?? []);
  const summary = results.reduce(
    (acc, r) => ({
      total: acc.total + r.summary.total,
      succeeded: acc.succeeded + r.summary.succeeded,
      failed: acc.failed + r.summary.failed,
    }),
    { total: 0, succeeded: 0, failed: 0 },
  );
  const merged: BatchActionsResult = {
    success: results.every((r) => r.success),
    parentExecutionId: first.parentExecutionId,
    strategy: first.strategy,
    succeeded,
    failed,
    summary,
  };
  if (rolledBack.length > 0) {
    merged.rolledBack = rolledBack;
  }
  return merged;
}

// ── Fetch ──────────────────────────────────────────────────

/** Auth/tenant headers — mirrors api.ts to keep wire conventions identical. */
function getAuthHeaders(): Record<string, string> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("linchkit:token") : null;
  const tenantHeaders = getTenantHeaders();
  if (token) {
    return { Authorization: `Bearer ${token}`, ...tenantHeaders };
  }
  return { ...tenantHeaders };
}

/** Build a synthetic failed item for transport errors so callers see them inline. */
function buildTransportFailure(
  items: BatchActionItem[],
  reason: string,
  baseIndex: number,
): BatchActionsResult {
  return {
    success: false,
    parentExecutionId: "",
    strategy: "partial",
    succeeded: [],
    failed: items.map((_, i) => ({
      index: baseIndex + i,
      error: { code: "BATCH.TRANSPORT", message: reason },
    })),
    summary: { total: items.length, succeeded: 0, failed: items.length },
  };
}

/**
 * Send a single chunk to `/api/actions/batch`. Transport / HTTP failures are
 * folded into a synthetic `BatchActionsResult` so the caller's aggregation
 * stays uniform — never throws.
 */
async function postBatchChunk(
  items: BatchActionItem[],
  strategy: BatchTransactionStrategy,
  baseIndex: number,
  fetchImpl: typeof fetch,
): Promise<BatchActionsResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/actions/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ actions: items, strategy }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Network error";
    return buildTransportFailure(items, reason, baseIndex);
  }

  if (!res.ok) {
    let reason = `Batch request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } } | null;
      if (body?.error?.message) reason = body.error.message;
    } catch {
      // Body wasn't JSON — keep status-derived reason.
    }
    return buildTransportFailure(items, reason, baseIndex);
  }

  const body = (await res.json()) as BatchActionsResult;
  // Re-base per-item indices into the absolute selection so UIs that show
  // "row N failed" stay correct across chunk boundaries.
  if (baseIndex !== 0) {
    return {
      ...body,
      succeeded: body.succeeded.map((s) => ({ ...s, index: s.index + baseIndex })),
      failed: body.failed.map((f) => ({ ...f, index: f.index + baseIndex })),
      ...(body.rolledBack
        ? { rolledBack: body.rolledBack.map((s) => ({ ...s, index: s.index + baseIndex })) }
        : {}),
    };
  }
  return body;
}

// ── Public API ─────────────────────────────────────────────

export interface ExecuteBatchActionOptions {
  /** Action name to invoke for every selected record. */
  actionName: string;
  /** Selected record ids — chunked client-side at `BATCH_CHUNK_SIZE`. */
  recordIds: string[];
  /**
   * Transaction strategy. Defaults to `'partial'` so a single failing record
   * does not undo successful peers. Pass `'all_or_nothing'` when the action
   * declares a transactional contract that must hold across the whole batch.
   */
  strategy?: BatchTransactionStrategy;
  /**
   * Field name used to bind the record id into the action input. Defaults to
   * `'id'` — the meta-model convention. Override for actions that take a
   * different key (e.g. `record_id`).
   */
  idField?: string;
  /**
   * Extra static input merged into every per-record payload — useful when
   * the action also needs values picked from the chooser (e.g. a target
   * status). Per-record `idField` always wins on key collision.
   */
  extraInput?: Record<string, unknown>;
  /** Fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Execute an action against many record ids via `/api/actions/batch`.
 *
 * - Chunks `recordIds` into batches of `BATCH_CHUNK_SIZE` (500) and sends
 *   them sequentially. Sequential matters for `all_or_nothing`: each chunk
 *   is its own server-side transaction, but per-chunk ordering is preserved.
 * - Aggregates per-chunk results into one `BatchActionsResult`.
 * - Never throws; transport / HTTP failures appear in `failed`.
 */
export async function executeBatchAction(
  options: ExecuteBatchActionOptions,
): Promise<BatchActionsResult> {
  const {
    actionName,
    recordIds,
    strategy = "partial",
    idField = "id",
    extraInput,
    fetchImpl = fetch,
  } = options;

  const chunks = chunkIds(recordIds);
  const results: BatchActionsResult[] = [];

  let baseIndex = 0;
  for (const chunk of chunks) {
    const items: BatchActionItem[] = chunk.map((id) => ({
      name: actionName,
      input: { ...(extraInput ?? {}), [idField]: id },
    }));
    const chunkResult = await postBatchChunk(items, strategy, baseIndex, fetchImpl);
    results.push(chunkResult);
    baseIndex += chunk.length;
  }

  return aggregateBatchResults(results);
}
