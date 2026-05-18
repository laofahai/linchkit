/**
 * Intent Resolver — Public Types (Spec 52 §2.2 / §2.5)
 *
 * Pure type definitions for the natural-language intent resolution pipeline.
 * Kept separate from the resolver runtime so downstream packages (route
 * adapters, MCP transports, AI providers) can consume the contract without
 * pulling in the resolver implementation.
 *
 * The headline type is `Intent` — a discriminated union covering every
 * outcome the resolver can produce:
 *
 *   - `IntentMatch`        — confident enough to render an Action Proposal Card.
 *   - `IntentMultiStep`    — multi-step intent flagged for Saga execution.
 *   - `IntentClarification`— low confidence; ask the user a question.
 *   - `IntentNoMatch`      — graceful degradation (AI unavailable, blocked, …).
 *
 * Why discriminated union (vs. nullable `IntentResolution`):
 *   The previous Phase 0 PoC in `cap-ai-provider` returned `ActionProposal | null`,
 *   collapsing "no match", "below-confidence floor", "AI unavailable", and
 *   "multi-step request" into the same null. Spec 52 §2.2 step 5 explicitly
 *   requires a *clarification question* for low-confidence cases, and §2.5
 *   requires multi-step intents to be surfaced as a sequence (not a single
 *   proposal). The discriminated union makes both first-class so the UI can
 *   render the right component without re-deriving the case from heuristics.
 */

// ── Slot extraction ──────────────────────────────────────────

/**
 * One parameter slot extracted from the user utterance. Mirrors a single
 * field on the chosen action's input schema.
 *
 * The resolver populates `value` only when the user explicitly stated the
 * value — slots whose value the AI guessed at are dropped before reaching
 * this shape. Slots the AI failed to fill but the action requires appear
 * in `IntentMatch.missingFields` instead, so the UI can prompt for them.
 */
export interface IntentSlot {
  /** Input field name on the chosen action. */
  name: string;
  /** Extracted value (already validated against `unknown` — caller coerces). */
  value: unknown;
  /** Source span from the utterance, when the AI surfaces it. Optional. */
  source?: string;
}

// ── Match (single-step proposal) ────────────────────────────

/**
 * A confident, single-action intent ready to render as an Action Proposal
 * Card. The caller still gates execution behind a user confirmation —
 * the resolver itself never executes (Spec 52 §1.1).
 */
export interface IntentMatch {
  kind: "match";
  /** Matched action name (always non-empty for `kind === "match"`). */
  action: string;
  /** Entity the matched action operates on. */
  entity: string;
  /** Pre-filled input parameters validated against the action's catalog entry. */
  input: Record<string, unknown>;
  /**
   * Slots extracted from the utterance. Subset of `input` enriched with
   * provenance — present so future telemetry (Spec 52 §8.1) can audit
   * how each value was chosen.
   */
  slots: IntentSlot[];
  /** Required fields the AI did not fill. UI prompts the user for these. */
  missingFields: string[];
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Short human-readable summary suitable for the confirmation card. */
  explanation: string;
  /**
   * Optional alternative single-step matches the AI surfaced. Useful for
   * "Did you mean..." chips when confidence is borderline. Never present
   * when confidence is high enough to be unambiguous.
   */
  alternatives?: IntentAlternative[];
}

/**
 * A single alternative match. Same shape as `IntentMatch` minus the
 * recursive `alternatives` field — alternatives never themselves carry
 * alternatives, to keep the wire format flat.
 */
export interface IntentAlternative {
  action: string;
  entity: string;
  input: Record<string, unknown>;
  confidence: number;
  explanation: string;
  missingFields: string[];
}

// ── Multi-step (Saga) ────────────────────────────────────────

/**
 * A single step inside a multi-step intent. Mirrors `IntentMatch` minus
 * confidence / alternatives — the AI returns one confidence for the whole
 * sequence rather than per-step. Each step is reconciled against the
 * scoped ontology the same way a single-step proposal is.
 */
export interface IntentStep {
  /** Position in the sequence (0-indexed). */
  index: number;
  /** Action name (must appear in the scoped catalog). */
  action: string;
  /** Entity the action operates on. */
  entity: string;
  /** Pre-filled input parameters. */
  input: Record<string, unknown>;
  /** Required fields the AI did not fill on this step. */
  missingFields: string[];
  /**
   * Short human-readable label suitable for rendering a step row in the
   * Action Sequence Card (Spec 52 §2.5).
   */
  explanation: string;
  /**
   * Optional reference to a previous step's output. When set, the executor
   * substitutes `${steps[fromIndex].result.<path>}` into this step's input
   * at the named path. Concrete substitution is the orchestrator's job —
   * the resolver only declares the dependency so the UI can render the
   * "pending step N" badge.
   */
  dependsOn?: number;
}

/**
 * A multi-step intent. Per Spec 52 §2.5, surfaced separately from a single
 * proposal so the UI can render an Action Sequence Card and the runtime
 * can choose between sequential execution and a Saga orchestrator.
 *
 * Flagging this as its own discriminant lets callers refuse to auto-execute
 * multi-step intents (since each step needs its own confirmation under the
 * "AI proposes, user confirms" rule).
 */
export interface IntentMultiStep {
  kind: "multi_step";
  /** Ordered list of steps to execute. */
  steps: IntentStep[];
  /** Overall sequence confidence (governs whether to render or clarify). */
  confidence: number;
  /** Short human-readable summary of the whole sequence. */
  explanation: string;
  /**
   * Whether the orchestrator should treat the sequence as a Saga. True when
   * any step's failure should roll the previous steps back (e.g. submit
   * after create). False for purely additive sequences. Defaults to true.
   */
  saga: boolean;
}

// ── Clarification (low confidence) ──────────────────────────

/**
 * A clarification question the UI presents back to the user when the AI
 * was not confident enough to propose an action (Spec 52 §2.2 step 5).
 * Distinct from `IntentNoMatch` so the UI can render a follow-up prompt
 * rather than a "couldn't match" banner.
 */
export interface IntentClarification {
  kind: "clarification";
  /** Plain-language clarification question to show the user. */
  question: string;
  /**
   * Optional candidate actions the AI considered but isn't sure about.
   * Same shape as `IntentAlternative`. UI may render these as "Did you
   * mean..." chips so the user can resolve the ambiguity in one click.
   */
  candidates?: IntentAlternative[];
  /**
   * The best confidence the AI reported. Always below MIN_CONFIDENCE for
   * this shape; included for telemetry and UI ranking.
   */
  bestConfidence: number;
}

// ── No-match (graceful degradation) ──────────────────────────

/**
 * Resolver could not produce an actionable result. Distinct from
 * `IntentClarification`: no-match never has anything to clarify. Reasons
 * include AI unavailable, empty utterance, blocked by sanitizer, malformed
 * AI response.
 */
export interface IntentNoMatch {
  kind: "no_match";
  /** Machine-readable reason code (stable across versions for audit logs). */
  reason:
    | "empty_utterance"
    | "blocked_by_sanitizer"
    | "ai_unavailable"
    | "ai_malformed_response"
    | "no_actions_in_scope"
    | "no_action_matched";
  /** Human-readable explanation, suitable for surfacing in the UI. */
  message: string;
}

// ── Union ────────────────────────────────────────────────────

/**
 * The full discriminated union covering every resolver outcome. Callers
 * narrow on `kind` and render the matching UI component (proposal card,
 * sequence card, clarification prompt, or unavailable banner).
 */
export type Intent = IntentMatch | IntentMultiStep | IntentClarification | IntentNoMatch;

// ── Resolver inputs ──────────────────────────────────────────

/**
 * A single message in the conversation history passed back to the
 * resolver. Mirrors `AISessionMessage` from `conversation-manager.ts`
 * but locally defined so the resolver has no circular dependency on
 * conversation storage — callers convert before invoking the resolver.
 */
export interface IntentHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Optional resolver tuning knobs. All defaults are picked to match
 * Spec 52 §2.2 / §2.5; tests typically override to exercise edge cases.
 */
export interface IntentResolverOptions {
  /**
   * Confidence floor below which the resolver returns
   * `IntentClarification` instead of `IntentMatch` (Spec 52 §2.2 step 5).
   * Default: 0.4.
   */
  minConfidence?: number;
  /**
   * Confidence threshold below which the resolver invites the AI to
   * surface "Did you mean..." alternatives (Spec 52 §2.2 step 4).
   * Default: 0.7.
   */
  alternativesThreshold?: number;
  /** Maximum number of alternatives surfaced. Default: 3. */
  maxAlternatives?: number;
  /**
   * Maximum number of history messages forwarded to the AI. Older
   * messages are dropped (the conversation manager owns summarization
   * — the resolver just truncates). Default: 6 (last 3 turns).
   */
  maxHistoryMessages?: number;
  /**
   * Whether to run the prompt sanitizer on the utterance before sending
   * it to the AI. When sanitizer blocks the prompt the resolver returns
   * `IntentNoMatch{reason: "blocked_by_sanitizer"}`. Default: true.
   */
  sanitizeUtterance?: boolean;
}
