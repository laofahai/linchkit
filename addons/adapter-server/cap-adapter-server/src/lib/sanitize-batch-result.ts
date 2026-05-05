/**
 * Production-mode sanitization for batch action results.
 *
 * Replaces per-item `error.message` strings with a generic placeholder
 * to avoid leaking internal details (driver errors, stack-trace fragments,
 * handler exception text) over the wire. Codes and field locators are
 * preserved so clients can still differentiate validation vs. permission
 * failures. `rolledBack` items are successes (no error message), so they
 * are passed through untouched.
 *
 * Shared by REST (`/api/actions/batch`) and GraphQL (`Mutation.batch_actions`)
 * so both transports apply identical dev-mode parity (full message visible)
 * and prod-mode safety.
 */

import type { BatchActionsResult } from "@linchkit/core";

const GENERIC_FAILURE_MESSAGE = "Action execution failed";

export function sanitizeBatchResult(result: BatchActionsResult): BatchActionsResult {
  const isDevMode = process.env.NODE_ENV !== "production";
  if (isDevMode) return result;
  return {
    ...result,
    failed: result.failed.map((f) => ({
      ...f,
      error: { ...f.error, message: GENERIC_FAILURE_MESSAGE },
    })),
  };
}
