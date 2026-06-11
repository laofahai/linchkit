/**
 * Action error surfacing helpers.
 *
 * Resolves the human-readable failure message from a failed action result so
 * UI callers (form action handlers, transition dispatch) can show the rule
 * author's user-facing policy text instead of a generic failure string.
 * Extracted from lib/api.ts to keep action-error logic in one focused module.
 */

/**
 * Resolve the human-readable failure message from a failed action result.
 *
 * First arm: the REST action endpoint lifts the failure reason (e.g. a
 * rule-block message) into `error.message` (see adapter-server
 * routes/action-api.ts) — this is the only shape today's REST transport
 * produces, since REST failure envelopes carry no `data` key.
 *
 * Second arm: the raw core ActionResult shape — a `data.error` string with
 * `data.context.constraint === "rule_block"`. It exists for direct core-seam
 * consumers / non-REST transports (defense in depth; unreachable via today's
 * REST transport) and mirrors the server's sanitization policy: ONLY a
 * rule-block reason (the rule author's user-facing policy text) is surfaced
 * verbatim; any other raw `data.error` is ignored so internal details never
 * leak past what the REST envelope would have exposed.
 *
 * Accepts a nullish result defensively. Returns undefined when no
 * surfaceable message exists so callers fall back to their generic i18n text.
 */
export function resolveActionErrorMessage(
  result: { success: boolean; error?: { message?: string }; data?: unknown } | null | undefined,
): string | undefined {
  if (!result) return undefined;
  const fromError = result.error?.message;
  if (typeof fromError === "string" && fromError.length > 0) return fromError;
  const data = result.data;
  if (data && typeof data === "object" && "error" in data) {
    const { error: fromData, context } = data as { error?: unknown; context?: unknown };
    const constraint =
      context && typeof context === "object"
        ? (context as { constraint?: unknown }).constraint
        : undefined;
    if (constraint === "rule_block" && typeof fromData === "string" && fromData.length > 0) {
      return fromData;
    }
  }
  return undefined;
}
