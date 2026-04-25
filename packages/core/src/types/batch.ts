/**
 * Batch action type definitions (Spec 04 §8, Spec 16 §2.1).
 *
 * Batch operations execute multiple actions through the Command Layer in
 * one call. A parent execution groups all child executions; each child
 * runs the same single-action pipeline (auth/exposure/permission/tenant/
 * pre-action/post-action) so security guarantees match a per-action call.
 *
 * Two transactional strategies (Spec 04 §8.2):
 * - `all_or_nothing` (default): all items run inside one shared DB
 *   transaction. Any failure rolls back every prior write.
 * - `partial`: each item runs in its own transaction; the response reports
 *   per-item success/failure.
 */

/** Strategy controlling cross-item transactionality (Spec 04 §8.2). */
export type BatchTransactionStrategy = "all_or_nothing" | "partial";

/** A single action invocation within a batch payload. */
export interface BatchActionItem {
  /** Action name (verb_noun). Different items may invoke different actions. */
  name: string;
  /** Action input. Same shape as a single-action call. */
  input: Record<string, unknown>;
}

/** Top-level batch input. */
export interface BatchActionsInput {
  /** Action items to execute, in order. */
  actions: BatchActionItem[];
  /**
   * Transaction strategy. Defaults to `'all_or_nothing'` per Spec 04 §8.2 —
   * the conservative choice for write batches.
   */
  strategy?: BatchTransactionStrategy;
}

/** Result for a single succeeded action item. */
export interface BatchSucceededItem {
  /** Position in the input `actions` array. */
  index: number;
  /** Child execution ID. */
  executionId: string;
  /** Action `data` payload (handler return value). */
  data?: unknown;
  /** Action `record` payload when present. */
  record?: Record<string, unknown>;
  /** Warnings surfaced by post-action hooks, etc. */
  warnings?: string[];
}

/** Result for a single failed action item. */
export interface BatchFailedItem {
  /** Position in the input `actions` array. */
  index: number;
  /** Child execution ID, if the executor produced one before failing. */
  executionId?: string;
  /** Structured error. */
  error: { code: string; message: string; field?: string };
}

/** Top-level batch result returned by `executeBatch` / `CommandLayer.executeBatch`. */
export interface BatchActionsResult {
  /**
   * Overall success. `true` iff every item succeeded (any strategy).
   * For `all_or_nothing` rollback this is always `false`.
   */
  success: boolean;
  /** Parent execution ID grouping all child executions. */
  parentExecutionId: string;
  /** Strategy actually used (echoed back for clients that omit it). */
  strategy: BatchTransactionStrategy;
  /**
   * Items that succeeded.
   *
   * For `all_or_nothing` rollback this is always empty — successful items
   * are surfaced via `rolledBack` instead.
   */
  succeeded: BatchSucceededItem[];
  /**
   * Items that failed. For `all_or_nothing` rollback this contains exactly
   * the item that triggered the abort (later items never ran).
   */
  failed: BatchFailedItem[];
  /**
   * Items that ran successfully but were rolled back because a later item
   * failed. Only populated under `all_or_nothing` rollback. Useful for
   * observability: clients can show "we tried these items but had to undo
   * them when item N failed".
   */
  rolledBack?: BatchSucceededItem[];
  /** Aggregate counts. */
  summary: { total: number; succeeded: number; failed: number };
}
