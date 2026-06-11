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
 * EXCEPTION: a rule `block` reason is the rule author's user-facing policy
 * text (e.g. "Amounts over 10000 require manager approval") — written
 * precisely to be shown to the caller. The batch engine threads the
 * server-stamped `constraint: "rule_block"` marker onto the failed item, so
 * detection never depends on message content. This mirrors the single-action
 * exemption in `routes/action-api.ts`.
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
    failed: result.failed.map((f) => {
      // Engine-stamped policy marker — keep the rule author's policy text.
      // Re-check the message type at runtime: upstream casts could smuggle a
      // non-string value past the compiler.
      const isPolicyMessage =
        f.error.constraint === "rule_block" && typeof f.error.message === "string";
      if (isPolicyMessage) return f;
      return {
        ...f,
        error: { ...f.error, message: GENERIC_FAILURE_MESSAGE },
      };
    }),
  };
}
