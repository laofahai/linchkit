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
 * Scope (intentionally narrow):
 *   - `add_rule` + `update_rule` ONLY (no rename/delete, no multi-rule edits).
 *     Entity / field / view creation are later slices.
 *   - Single-shot (no multi-turn). The resolver returns one of three
 *     outcomes and stops.
 *   - Stops at `draft`. The caller never submits/applies from this path.
 *
 * The headline type is `SchemaIntentOutcome` — a discriminated union
 * mirroring the four-state shape of `Intent`, collapsed to the three
 * outcomes meaningful for a schema-change proposal:
 *
 *   - `SchemaIntentProposalDraft` — a governed `add_rule` / `update_rule`
 *     Proposal (draft).
 *   - `SchemaIntentClarification` — low confidence; ask the user a question.
 *   - `SchemaIntentNoMatch`       — graceful degradation / no usable rule.
 */

import type { DeclarativeCondition } from "../types/rule";
import type { Proposal } from "./proposal-engine";

// ── Proposal-draft outcome ───────────────────────────────────

/**
 * A confident schema-change intent that produced a governed `add_rule` or
 * `update_rule` Proposal. The Proposal is created via
 * `ProposalEngine.createProposal()` and is ALWAYS in `draft` status — the
 * resolver never submits or applies it. The caller surfaces it for human
 * review (Spec 15 §8 Proposal UI).
 */
export interface SchemaIntentProposalDraft {
  kind: "proposal_draft";
  /**
   * The governed draft Proposal. `proposal.status` is always `"draft"` and
   * `proposal.type` is `"add_rule"` or `"update_rule"`.
   */
  proposal: Proposal;
  /**
   * What the draft does to the rule: `"create"` mints a new rule
   * (`add_rule`), `"update"` modifies an EXISTING rule (`update_rule`).
   * Mirrors `proposal.diff.operation`.
   */
  operation: "create" | "update";
  /**
   * Rule name. For `create` this is the generated name; for `update` it is
   * the EXISTING rule's name (validated against the ontology's rule list —
   * renames are out of scope).
   */
  ruleName: string;
  /** Entity the proposed rule is attached to (validated against the ontology). */
  targetEntity: string;
  /** Confidence in [0, 1] carried from the AI response. */
  confidence: number;
  /** Short human-readable summary suitable for the Proposal review card. */
  explanation: string;
  /**
   * Present only for `update` — the human-readable diff summary describing
   * what changes versus the existing rule (carried into the governed
   * `ProposalChange.diff` field).
   */
  diffSummary?: string;
  /**
   * Present only for `update` of a NON-round-trippable rule: a CODE
   * condition (a TypeScript function the AI cannot see), a composite/not
   * condition, a non-action trigger, or a non-declarative effect — anything
   * the declarative rebuild path cannot express faithfully. The draft
   * carries NO definition — only the `diffSummary` describing the intended
   * change. A developer must apply the change in source; the draft is an
   * honest, governed change REQUEST.
   */
  requiresCodeChange?: boolean;
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
    | "unknown_rule"
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
 * Sanitized projection of an existing rule's effect payload — the declarative
 * fields `buildEffect` consumes when round-tripping an update (message for
 * block/warn, level for require_approval, setFields for enrich). Exposed in
 * the snapshot so the AI can keep unchanged effect fields IDENTICAL instead
 * of fabricating replacements (review-integrity: the diff must be honest).
 * Non-declarative effect payloads (execute_action / trigger_flow) carry only
 * `type` — such rules are never offered for declarative rebuild (see
 * `roundTrippable`).
 */
export interface SchemaIntentRuleEffect {
  type: string;
  message?: string;
  level?: string;
  setFields?: Record<string, unknown>;
}

/**
 * One EXISTING rule's grounding metadata, exposed so the AI can target it
 * with an `update_rule` intent (the AI can't update what it can't see).
 *
 * Declarative rules expose their full condition (the AI returns an updated
 * one). CODE-condition rules (a TypeScript function) are NOT round-trippable
 * — they expose `conditionKind: "code"` and their description only, never
 * the function source, so the AI cannot pretend to edit code it cannot see.
 */
export interface SchemaIntentRule {
  name: string;
  label?: string;
  description?: string;
  /**
   * Action name(s) from the rule's trigger, when it is an action trigger.
   * Absent for stateChange / fieldChange / event / schedule triggers.
   */
  triggerActions?: string[];
  /** The rule's effect type (`block`, `warn`, `require_approval`, …). */
  effectType: string;
  /**
   * Sanitized effect payload (message / level / setFields) so an update can
   * round-trip unchanged effect fields faithfully instead of fabricating
   * replacements. Optional for legacy snapshots / test fixtures.
   */
  effect?: SchemaIntentRuleEffect;
  /** The rule's evaluation priority, preserved verbatim across updates. */
  priority?: number;
  /** Whether the condition is declarative (editable) or code (opaque). */
  conditionKind: "declarative" | "code";
  /** The declarative condition. Present only when `conditionKind` is `"declarative"`. */
  condition?: DeclarativeCondition;
  /**
   * Whether the FULL rule can be rebuilt declaratively from an AI-returned
   * definition. `false` for rules the rebuild path cannot express faithfully:
   * composite/not conditions (the builder only rebuilds simple conditions),
   * non-action triggers (stateChange / fieldChange / event / schedule — the
   * builder only emits `{action}`), and non-declarative effects
   * (execute_action / trigger_flow). Such rules take the SAME honest
   * diff-only path as code-backed rules — the draft carries no definition,
   * only the human-readable diff (`requiresCodeChange`). Absent (legacy
   * snapshots) means round-trippable when `conditionKind` is `"declarative"`.
   */
  roundTrippable?: boolean;
}

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
  /**
   * EXISTING rules attached to this entity — the `update_rule` target list.
   * Optional so legacy ontology snapshots (and test fixtures) that predate
   * update support keep working; absent/empty means nothing is updatable.
   */
  rules?: SchemaIntentRule[];
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
