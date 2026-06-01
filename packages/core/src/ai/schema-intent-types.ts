/**
 * Schema Intent Resolver — Public Types (Spec 52 "说→有", first slice)
 *
 * Pure type definitions for the natural-language → metamodel-change pipeline.
 * This is the governed sibling of `intent-types.ts`:
 *
 *   - `intent-types.ts` turns an utterance into a RUNTIME DATA action
 *     (create/submit a record). Its outcome is confirmed by the user and
 *     replayed through `POST /api/actions/:name`.
 *   - THIS module turns an utterance into a METAMODEL CHANGE (a new
 *     `defineRule()`), surfaced ONLY as a governed `add_rule` Proposal in
 *     `draft` status. Nothing is ever auto-submitted or applied — that is
 *     the repo principle "AI Never Modifies Production Directly".
 *
 * Scope of this first slice (intentionally narrow):
 *   - `add_rule` ONLY. Entity / field / view creation are later slices.
 *   - Single-shot (no multi-turn). The resolver returns one of three
 *     outcomes and stops.
 *   - Stops at `draft`. The caller never submits/applies from this path.
 *
 * The headline type is `SchemaIntentOutcome` — a discriminated union
 * mirroring the four-state shape of `Intent`, collapsed to the three
 * outcomes meaningful for a schema-change proposal:
 *
 *   - `SchemaIntentProposalDraft` — a governed `add_rule` Proposal (draft).
 *   - `SchemaIntentClarification` — low confidence; ask the user a question.
 *   - `SchemaIntentNoMatch`       — graceful degradation / no usable rule.
 */

import type { Proposal } from "./proposal-engine";

// ── Proposal-draft outcome ───────────────────────────────────

/**
 * A confident schema-change intent that produced a governed `add_rule`
 * Proposal. The Proposal is created via `ProposalEngine.createProposal()`
 * and is ALWAYS in `draft` status — the resolver never submits or applies
 * it. The caller surfaces it for human review (Spec 15 §8 Proposal UI).
 */
export interface SchemaIntentProposalDraft {
  kind: "proposal_draft";
  /**
   * The governed draft Proposal. `proposal.status` is always `"draft"` and
   * `proposal.type` is always `"add_rule"` for this slice.
   */
  proposal: Proposal;
  /** Generated rule name (also present inside `proposal.diff.definition`). */
  ruleName: string;
  /** Entity the proposed rule is attached to (validated against the ontology). */
  targetEntity: string;
  /** Confidence in [0, 1] carried from the AI response. */
  confidence: number;
  /** Short human-readable summary suitable for the Proposal review card. */
  explanation: string;
}

// ── Clarification outcome ────────────────────────────────────

/**
 * A clarification question the UI presents when the AI was not confident
 * enough to draft a rule (Spec 52 §2.2 step 5, applied to schema changes).
 * Distinct from `no_match`: there is a concrete question to ask.
 */
export interface SchemaIntentClarification {
  kind: "clarification";
  /** Plain-language clarification question to show the user. */
  question: string;
  /**
   * The best confidence the AI reported. Always below the confidence floor
   * for this shape; included for telemetry and UI ranking.
   */
  bestConfidence: number;
}

// ── No-match outcome ─────────────────────────────────────────

/**
 * The resolver could not produce a draftable rule. Distinct from
 * `clarification`: there is nothing to clarify. Reasons mirror the
 * intent resolver's stable, machine-readable codes so audit logs stay
 * uniform across both NL pipelines.
 */
export interface SchemaIntentNoMatch {
  kind: "no_match";
  /** Machine-readable reason code (stable across versions for audit logs). */
  reason:
    | "empty_utterance"
    | "blocked_by_sanitizer"
    | "ai_unavailable"
    | "ai_malformed_response"
    | "no_entities_in_scope"
    | "unknown_entity"
    | "invalid_rule"
    | "no_rule_drafted";
  /** Human-readable explanation, suitable for surfacing in the UI. */
  message: string;
}

// ── Union ────────────────────────────────────────────────────

/**
 * The full discriminated union covering every schema-intent outcome.
 * Callers narrow on `kind` and render the matching UI: a Proposal review
 * card (`proposal_draft`), a clarification prompt (`clarification`), or an
 * "AI unavailable / no match" banner (`no_match`).
 */
export type SchemaIntentOutcome =
  | SchemaIntentProposalDraft
  | SchemaIntentClarification
  | SchemaIntentNoMatch;

// ── Ontology snapshot the resolver consumes ──────────────────

/**
 * One entity's grounding metadata passed to the prompt builder so the AI
 * can target a real entity + reference real fields when composing the
 * rule's condition/effect. All strings are admin-controlled DATA, never
 * instructions (the prompt builder serializes them as JSON).
 */
export interface SchemaIntentEntity {
  name: string;
  label?: string;
  description?: string;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    label?: string;
    description?: string;
  }>;
  /**
   * Names of actions defined on this entity. The AI may reference one as a
   * rule `trigger.action` (e.g. `submit_purchase_request`). Empty when the
   * entity exposes no actions.
   */
  actionNames: string[];
}

/**
 * Minimal `OntologyRegistry` projection the schema-intent resolver depends
 * on. Kept structural (dependency-light) so callers can pass either the
 * real registry adapter or a fake in tests.
 */
export interface SchemaIntentOntology {
  /** All entity names visible in the requested scope. */
  listEntities(): string[];
  /** Grounding metadata for one entity, or `undefined` if unknown. */
  describeEntity(entityName: string): SchemaIntentEntity | undefined;
}

// ── Resolver tuning knobs ────────────────────────────────────

/**
 * Optional tuning knobs for `resolveSchemaIntent()`. Defaults match the
 * intent resolver's confidence semantics so both NL pipelines behave
 * consistently; tests typically override to exercise edge cases.
 */
export interface SchemaIntentResolverOptions {
  /**
   * Confidence floor below which the resolver returns
   * `SchemaIntentClarification` instead of drafting a Proposal. Default: 0.4.
   */
  minConfidence?: number;
  /**
   * Whether to run the prompt sanitizer on the utterance before sending it
   * to the AI. When the sanitizer blocks the prompt the resolver returns
   * `SchemaIntentNoMatch{reason: "blocked_by_sanitizer"}`. Default: true.
   */
  sanitizeUtterance?: boolean;
}
