/**
 * Batch Action Engine — implements `batch_actions` (Spec 04 §8, Spec 16 §2.1).
 *
 * Direct executor-level batch entry point. The Command Layer's
 * `executeBatch` method delegates here for `all_or_nothing` shared-tx
 * orchestration, but `executeBatch` can also be called from internal
 * code that has an `ActionExecutor` directly (e.g. tests, scripts).
 *
 * v1 scope:
 *  - `all_or_nothing` (default) — one outer DB transaction wraps every
 *    item; any failure rolls back every prior write. Reuses the existing
 *    `_txDataProvider` / `_parentPendingEvents` plumbing in
 *    `ActionExecutor.execute()` so child executions participate in the
 *    parent transaction without any executor-level changes.
 *  - `partial` — sequential, independent execution. Each item runs in its
 *    own transaction (managed by the executor's normal flow); failures
 *    are recorded and execution continues.
 *
 * Deferred (Spec 04 §8.2 — follow-up issues):
 *  - Rule-evaluation merging (collect once, evaluate per record).
 *  - Batch event merging into `record.batch_*` events.
 *  - Parallel `partial`-mode execution (sequential is fine for v1: order
 *    matters in many UIs and serial keeps DB connection usage bounded).
 */

import type { Actor } from "../types/action";
import type { BatchActionsInput, BatchActionsResult, BatchSucceededItem } from "../types/batch";
import type { ExecutionMeta } from "../types/execution-meta";
import { createExecutionMeta, extendExecutionMeta } from "../types/execution-meta";
import type {
  ActionExecutor,
  DataProvider,
  ExecuteOptions,
  ExecutionChannel,
  PendingEvent,
  TransactionManager,
} from "./action-engine";
import { generateExecutionId } from "./action-helpers";

/**
 * Maximum number of items allowed in a single batch.
 *
 * Conservative starting value. Rationale:
 *  - Each item runs the full pipeline (auth/permission/tenant + executor),
 *    so very large batches multiply per-call overhead.
 *  - `all_or_nothing` holds one DB transaction open for the entire batch;
 *    long transactions block other writers and risk timeouts on Postgres.
 *  - 500 covers the typical bulk-edit UI use case (a list page selection)
 *    while leaving headroom to raise the limit later without breaking
 *    callers built against a smaller value.
 */
export const MAX_BATCH_SIZE = 500;

/**
 * Reserved meta key for the batch parent execution ID.
 *
 * Note: NOT underscore-prefixed. The action engine treats the root meta as
 * external input and strips `_`-prefixed keys (Spec 65 §4.4 — system-key
 * namespace protection). Using `batch.*` here keeps the key visible to
 * handlers and execution logs without smuggling it through the system-key
 * channel.
 */
const BATCH_PARENT_META_KEY = "batch.parentExecutionId";

/** Reserved meta key for the item's index within the batch. */
const BATCH_INDEX_META_KEY = "batch.index";

/** Options for {@link executeBatch}. */
export interface ExecuteBatchOptions {
  /** Executor used to dispatch each item. */
  executor: ActionExecutor;
  /**
   * Transaction manager used by `all_or_nothing` to wrap every item in one
   * transaction. Required for `all_or_nothing` — the function throws if
   * absent rather than silently degrading to per-item transactions.
   * Optional for `partial`.
   */
  transactionManager?: TransactionManager;
  /** Caller actor — propagated to every child execution. */
  actor: Actor;
  /** Channel — propagated to every child execution (default: `internal`). */
  channel?: ExecutionChannel;
  /** Tenant ID — propagated to every child execution. */
  tenantId?: string;
  /** Locale — propagated to every child execution. */
  locale?: string;
  /**
   * Caller-supplied meta. Merged into each child execution under the same
   * key namespace. The framework adds `batch.parentExecutionId` and
   * `batch.index` automatically.
   */
  meta?: ExecutionMeta | Record<string, unknown>;
}

/**
 * Internal sentinel thrown by `all_or_nothing` to roll back the outer
 * transaction. Carries the failed item plus everything that succeeded
 * before so the caller can report `rolledBack` in the final result.
 */
class BatchAbortError extends Error {
  constructor(
    public readonly failedIndex: number,
    public readonly failedExecutionId: string | undefined,
    public readonly failedErrorCode: string,
    public readonly failedErrorMessage: string,
    public readonly accumulatedSucceeded: BatchSucceededItem[],
  ) {
    super(`Batch aborted at index ${failedIndex}: ${failedErrorMessage}`);
    this.name = "BatchAbortError";
  }
}

/**
 * Build a child meta carrying the batch-tracking keys. We always start
 * from an {@link ExecutionMeta} (creating one when the caller supplied
 * a plain record) so `extendExecutionMeta` can stamp the system keys
 * without going through the untrusted-input factory each time.
 */
function buildItemMeta(
  parentMeta: ExecutionMeta | Record<string, unknown> | undefined,
  parentExecutionId: string,
  index: number,
): ExecutionMeta {
  // Add the batch tracking keys via the regular `extra` channel — the action
  // engine treats root meta as external input and only `extra` (non-underscore)
  // keys survive `createExecutionMeta`'s system-key namespace strip. Caller
  // meta still wins on collision (parent-wins semantics inside `extend`),
  // so a caller cannot accidentally clobber these tracking keys by passing
  // colliding values; we set them on a fresh ExecutionMeta below before
  // merging caller meta on top would invert that — instead we put them into
  // `extra` here, which `extend` skips when the parent already carries the
  // key, ensuring framework-owned values stay authoritative.
  //
  // To get framework-wins semantics on collision, we layer the parent meta
  // OVER the batch keys: build a meta carrying batch keys first, then call
  // `extend` with caller meta as `extra`. `extend`'s parent-wins rule then
  // means the batch keys (the new "parent") survive any caller-supplied
  // collision.
  const batchSeed = createExecutionMeta({
    raw: {
      [BATCH_PARENT_META_KEY]: parentExecutionId,
      [BATCH_INDEX_META_KEY]: index,
    },
  });

  // Layer caller meta on top — `extend` keeps the seed's value when keys
  // collide, so a caller passing `batch.index: 999` cannot override the
  // framework's value.
  const callerMeta = isExecutionMetaLike(parentMeta)
    ? parentMeta.toJSON()
    : ((parentMeta as Record<string, unknown> | undefined) ?? {});

  return extendExecutionMeta(batchSeed, callerMeta);
}

/** Duck-type check matching the action-engine helper (kept private here). */
function isExecutionMetaLike(value: unknown): value is ExecutionMeta {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.has === "function" &&
    typeof candidate.require === "function" &&
    typeof candidate.toJSON === "function"
  );
}

/** Map an action result's data payload to a structured error. */
function extractErrorFromResult(result: { data?: unknown }): {
  code: string;
  message: string;
  field?: string;
} {
  const data = result.data as Record<string, unknown> | undefined;
  const message = (data?.error as string) ?? "Action execution failed";
  const code = (data?.code as string) ?? "ACTION.EXECUTION.FAILED";
  const ctx = data?.context as Record<string, unknown> | undefined;
  const field = ctx?.field as string | undefined;
  return field ? { code, message, field } : { code, message };
}

/**
 * Build the structured result for a successful child execution.
 */
function toSucceededItem(
  index: number,
  executionId: string,
  result: { data?: unknown; record?: Record<string, unknown>; warnings?: string[] },
): BatchSucceededItem {
  const item: BatchSucceededItem = { index, executionId };
  if (result.data !== undefined) item.data = result.data;
  if (result.record !== undefined) item.record = result.record;
  if (result.warnings !== undefined && result.warnings.length > 0) {
    item.warnings = [...result.warnings];
  }
  return item;
}

/**
 * Execute a batch of actions via an {@link ActionExecutor}.
 *
 * The function returns a {@link BatchActionsResult} regardless of strategy.
 * Callers should NOT throw on a non-success result — failures are surfaced
 * through `failed` (and `rolledBack` for `all_or_nothing`).
 *
 * @throws Error when `all_or_nothing` is requested without a transaction manager.
 * @throws Error when the input violates the validation rules (empty / oversized)
 *   — emitted as a thrown error rather than a result so callers can rely on
 *   batch result shape only when the request was structurally valid. The
 *   {@link CommandLayer} wrapper translates these into structured failed
 *   responses for transport-layer callers.
 *
 *   Note: this function reports input validation errors via thrown exceptions
 *   AND structured results — the returned shape never silently swallows them.
 *   See the `BATCH_EMPTY` / `BATCH_TOO_LARGE` codes in {@link BatchValidationError}.
 */
export async function executeBatch(
  input: BatchActionsInput,
  options: ExecuteBatchOptions,
): Promise<BatchActionsResult> {
  const strategy = input.strategy ?? "all_or_nothing";
  const items = input.actions;
  const parentExecutionId = generateExecutionId();

  // ── Input validation ─────────────────────────────────────
  if (!Array.isArray(items) || items.length === 0) {
    throw new BatchValidationError("BATCH_EMPTY", "Batch must contain at least one action.");
  }
  if (items.length > MAX_BATCH_SIZE) {
    throw new BatchValidationError(
      "BATCH_TOO_LARGE",
      `Batch size ${items.length} exceeds the maximum of ${MAX_BATCH_SIZE}.`,
    );
  }

  if (strategy === "all_or_nothing" && !options.transactionManager) {
    throw new Error(
      "all_or_nothing strategy requires a TransactionManager. Pass one via options.transactionManager or use strategy: 'partial'.",
    );
  }

  // ── Common per-item executor options ─────────────────────
  const baseExecOptions: Pick<
    ExecuteOptions,
    "channel" | "tenantId" | "locale" | "skipExposureCheck"
  > = {
    channel: options.channel ?? "internal",
    tenantId: options.tenantId,
    locale: options.locale,
  };

  // ── Strategy: partial ────────────────────────────────────
  if (strategy === "partial") {
    return runPartial(items, parentExecutionId, options, baseExecOptions);
  }

  // ── Strategy: all_or_nothing ─────────────────────────────
  // We KNOW transactionManager is set (validated above). Capture in a const
  // so the closure does not have to re-narrow.
  const txManager = options.transactionManager as TransactionManager;
  return runAllOrNothing(items, parentExecutionId, options, baseExecOptions, txManager);
}

/** Execute items independently. Per-item failures don't stop the batch. */
async function runPartial(
  items: BatchActionsInput["actions"],
  parentExecutionId: string,
  options: ExecuteBatchOptions,
  baseExecOptions: Pick<ExecuteOptions, "channel" | "tenantId" | "locale" | "skipExposureCheck">,
): Promise<BatchActionsResult> {
  const succeeded: BatchSucceededItem[] = [];
  const failed: BatchActionsResult["failed"] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue; // defensive — type guarantees but keeps TS happy
    const meta = buildItemMeta(options.meta, parentExecutionId, i);
    const result = await options.executor.execute(item.name, item.input, options.actor, {
      ...baseExecOptions,
      meta,
    });
    if (result.success) {
      succeeded.push(toSucceededItem(i, result.executionId, result));
    } else {
      const err = extractErrorFromResult(result);
      failed.push({ index: i, executionId: result.executionId, error: err });
    }
  }

  return {
    success: failed.length === 0,
    parentExecutionId,
    strategy: "partial",
    succeeded,
    failed,
    summary: { total: items.length, succeeded: succeeded.length, failed: failed.length },
  };
}

/**
 * Execute all items inside one shared DB transaction. Any failure throws
 * a `BatchAbortError` to roll back; we then assemble a result reporting
 * the rolled-back items via `rolledBack`.
 */
async function runAllOrNothing(
  items: BatchActionsInput["actions"],
  parentExecutionId: string,
  options: ExecuteBatchOptions,
  baseExecOptions: Pick<ExecuteOptions, "channel" | "tenantId" | "locale" | "skipExposureCheck">,
  txManager: TransactionManager,
): Promise<BatchActionsResult> {
  const succeededInside: BatchSucceededItem[] = [];
  const sharedPendingEvents: PendingEvent[] = [];

  try {
    await txManager.runInTransaction(async (txProvider: DataProvider) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const meta = buildItemMeta(options.meta, parentExecutionId, i);
        const result = await options.executor.execute(item.name, item.input, options.actor, {
          ...baseExecOptions,
          meta,
          // Reuse the parent transaction for every item — the executor's
          // existing `_txDataProvider` short-circuit honors this seam.
          _txDataProvider: txProvider,
          _parentPendingEvents: sharedPendingEvents,
        });
        if (!result.success) {
          const err = extractErrorFromResult(result);
          throw new BatchAbortError(i, result.executionId, err.code, err.message, succeededInside);
        }
        succeededInside.push(toSucceededItem(i, result.executionId, result));
      }
    }, sharedPendingEvents);
  } catch (err) {
    if (err instanceof BatchAbortError) {
      return {
        success: false,
        parentExecutionId,
        strategy: "all_or_nothing",
        succeeded: [],
        failed: [
          {
            index: err.failedIndex,
            executionId: err.failedExecutionId,
            error: { code: err.failedErrorCode, message: err.failedErrorMessage },
          },
        ],
        rolledBack: err.accumulatedSucceeded,
        summary: { total: items.length, succeeded: 0, failed: 1 },
      };
    }
    // Unexpected throw (e.g., DB error inside runInTransaction). Surface as a
    // single failure at the next pending index so the caller still sees a
    // structured result. We don't know exactly which item triggered the
    // throw; report at `succeededInside.length` (the next item that would
    // have run) and include accumulatedSucceeded for diagnostics.
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      parentExecutionId,
      strategy: "all_or_nothing",
      succeeded: [],
      failed: [
        {
          index: succeededInside.length,
          error: { code: "BATCH_TRANSACTION_FAILED", message },
        },
      ],
      rolledBack: succeededInside,
      summary: { total: items.length, succeeded: 0, failed: 1 },
    };
  }

  return {
    success: true,
    parentExecutionId,
    strategy: "all_or_nothing",
    succeeded: succeededInside,
    failed: [],
    summary: {
      total: items.length,
      succeeded: succeededInside.length,
      failed: 0,
    },
  };
}

/**
 * Thrown when the batch input shape is invalid (empty array, oversized).
 * Callers (e.g. CommandLayer.executeBatch, REST handler) translate this
 * into a structured failed response.
 */
export class BatchValidationError extends Error {
  constructor(
    public readonly code: "BATCH_EMPTY" | "BATCH_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "BatchValidationError";
  }
}
