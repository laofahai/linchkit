/**
 * Schema Intent Resolver — tunable defaults + user-facing messages.
 *
 * Extracted into a leaf module so both `schema-intent-resolver.ts` and the
 * sibling reconciliation modules (`schema-intent-rule-updater.ts`) can share
 * them WITHOUT a circular import. Centralized for future i18n.
 */

// ── Tunable defaults ─────────────────────────────────────────

/** Confidence floor below which we ask a clarifying question instead of drafting. */
export const SCHEMA_INTENT_MIN_CONFIDENCE = 0.4;

/**
 * Stable text marker persisted on a governed diff-only update draft (the
 * `requiresCodeChange` outcome flag exists only in the HTTP response — the
 * PERSISTED proposal needs its own signal). Callers prepend it to the
 * governed change's `diff` / proposal description so a reviewer reading
 * /admin/proposals can distinguish an HONEST developer change-request
 * (no definition BY DESIGN) from a malformed change. Text-only on purpose:
 * `ProposalChange` has no structured extension point and core types are not
 * widened for this.
 */
export const REQUIRES_CODE_CHANGE_MARKER = "[requires-code-change]";

// ── User-facing messages (centralized for future i18n) ───────

export const SCHEMA_INTENT_MESSAGES = {
  emptyUtterance: "Utterance is empty; nothing to resolve.",
  blockedBySanitizer: "Utterance blocked by prompt sanitizer (possible injection attempt).",
  noEntitiesInScope: "No entities are available in the requested scope.",
  aiUnavailable: "AI provider unavailable.",
  aiUnavailableWithMessage: (message: string) => `AI provider error: ${message}`,
  aiMalformedResponse: "AI returned malformed JSON; could not parse the schema intent.",
  noRuleDrafted: "AI did not propose a rule for this request.",
  unknownEntity: (entity: string) => `AI proposed a rule for unknown entity "${entity}".`,
  unknownRule: (rule: string, entity: string) =>
    `AI proposed an update to unknown rule "${rule}" on entity "${entity}".`,
  invalidRule: (detail: string) => `AI proposed an invalid rule: ${detail}.`,
  invalidEntity: (detail: string) => `AI proposed an invalid entity: ${detail}.`,
  missingUpdateDiff: "AI proposed a code-backed rule update without describing what should change",
  lowConfidenceClarification:
    "I'm not sure what rule you want. Could you describe the condition and what should happen when it matches?",
  multiIntentClarification:
    "I detected both a request to create a new entity and a business rule. Should I draft the new entity first? The rule can be a separate follow-up.",
} as const;

export type SchemaIntentMessages = typeof SCHEMA_INTENT_MESSAGES;
