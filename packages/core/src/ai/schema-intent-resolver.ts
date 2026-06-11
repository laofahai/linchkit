/**
 * Schema Intent Resolver — NL utterance → governed `add_rule` / `update_rule`
 * ProposalDraft (Spec 52 "说→有").
 *
 * The bridge that was missing: the existing `resolveIntent()` (intent-
 * resolver.ts) turns an utterance into a RUNTIME DATA action; this resolver
 * turns an utterance into a METAMODEL CHANGE — a new `defineRule()` or an
 * UPDATE to an existing one — surfaced ONLY as a governed Proposal in
 * `draft` status via `ProposalEngine.createProposal()`.
 *
 * Pipeline (mirrors intent-resolver.ts):
 *   sanitize → build entity catalog (incl. existing rules) → build focused
 *   system prompt → call provider → parse + validate AI JSON → reconcile rule
 *   against the ontology → `ProposalEngine.createProposal(...)` → emit
 *   `SchemaIntentOutcome` (proposal_draft / clarification / no_match).
 *
 * Hard rules (repo principle "AI Never Modifies Production Directly"):
 *  - NEVER submits, approves, or applies. The returned Proposal is ALWAYS
 *    `draft`. Graduating it (draft→pending→…) is a separate, human-gated path.
 *  - `add_rule` + `update_rule` ONLY (no rename/delete). Entity/field/view
 *    creation is out of scope (later slices).
 *  - An `update_rule` may only target a rule present in the ontology's rule
 *    list (allowlist — the AI cannot update what it cannot see). A rule whose
 *    condition is CODE (a TS function) cannot be round-tripped declaratively;
 *    its update draft carries NO definition, only a human-readable diff
 *    summary, and is flagged `requiresCodeChange` (honest change REQUEST —
 *    a developer applies it in source).
 *  - Single-shot. No multi-turn, no history replay.
 *
 * Security posture (this is a prompt-injection-sensitive path):
 *  - `sanitizePrompt()` runs on the utterance (reused from prompt-sanitizer.ts);
 *    a blocked prompt short-circuits to `no_match`.
 *  - Entity/field/action metadata is serialized as JSON (DATA, not
 *    instructions); the system prompt tells the model to ignore embedded
 *    instructions.
 *  - The AI-proposed `targetEntity` is allowlisted against the ontology — an
 *    invented entity is refused even after a successful jailbreak.
 *  - The proposed rule's `trigger` / `condition` / `effect` are validated
 *    against a strict structural allowlist; the `field` referenced by a
 *    condition must exist on the target entity. Raw user text is never
 *    interpolated into a privileged context — only validated, structured
 *    values reach the Proposal.
 *  - Never throws — every failure path returns a `SchemaIntentNoMatch` so the
 *    caller renders a graceful UI state instead of handling exceptions.
 */

import type { AIMessage, AIService } from "../types/ai";
import type { RuleDefinition } from "../types/rule";
import { sanitizePrompt } from "./prompt-sanitizer";
import type { ProposalEngine } from "./proposal-engine";
// System prompt + response parser live in a sibling module (mirrors the
// intent-resolver.ts / intent-prompt.ts split) so this file stays focused on
// the pipeline + the governed Proposal mint.
import type { ParsedRuleShape, ParsedSchemaIntent } from "./schema-intent-prompt";
import { buildSchemaIntentSystemPrompt, parseSchemaIntentResponse } from "./schema-intent-prompt";
// Rule reconciliation + validation lives in a sibling module so this file
// stays under the 500-line ceiling and focuses on the pipeline.
import { buildRuleDefinition } from "./schema-intent-rule-builder";
import type {
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentOutcome,
  SchemaIntentResolverOptions,
  SchemaIntentRule,
} from "./schema-intent-types";

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
  missingUpdateDiff: "AI proposed a code-backed rule update without describing what should change",
  lowConfidenceClarification:
    "I'm not sure what rule you want. Could you describe the condition and what should happen when it matches?",
} as const;

export type SchemaIntentMessages = typeof SCHEMA_INTENT_MESSAGES;

// ── Input / deps ─────────────────────────────────────────────

/** Caller-supplied input to `resolveSchemaIntent()`. */
export interface ResolveSchemaIntentInput {
  /** Raw natural-language utterance from the user. */
  utterance: string;
  /** Tenant id forwarded to the AI service (BYOK provider config). */
  tenantId?: string;
  /** Calling user id — logged downstream for traceability. */
  userId?: string;
  /** Resolver tuning knobs. */
  options?: SchemaIntentResolverOptions;
}

/** Dependencies injected by the caller. */
export interface ResolveSchemaIntentDeps {
  /** AI service instance (typically `ctx.ai`). */
  provider: AIService;
  /** Ontology snapshot — only the methods in `SchemaIntentOntology` are used. */
  ontology: SchemaIntentOntology;
  /**
   * Governed proposal sink. The resolver calls `createProposal(...)` to mint
   * the `draft` Proposal. Inject the same engine instance the rest of the
   * app uses so drafts are queryable by the Proposal review UI.
   */
  proposalEngine: ProposalEngine;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Resolve a natural-language utterance into a governed `add_rule`
 * ProposalDraft, a clarification question, or a no-match.
 *
 * Never throws. The returned Proposal (when present) is ALWAYS in `draft`
 * status — this function does not submit or apply.
 */
export async function resolveSchemaIntent(
  input: ResolveSchemaIntentInput,
  deps: ResolveSchemaIntentDeps,
): Promise<SchemaIntentOutcome> {
  const options = input.options ?? {};
  const minConfidence = options.minConfidence ?? SCHEMA_INTENT_MIN_CONFIDENCE;
  const sanitize = options.sanitizeUtterance ?? true;

  // Step 1 — Sanitize the utterance (prompt-injection defense).
  const trimmed = (input.utterance ?? "").trim();
  if (trimmed.length === 0) {
    return noMatch("empty_utterance", SCHEMA_INTENT_MESSAGES.emptyUtterance);
  }
  let utterance = trimmed;
  if (sanitize) {
    // Run prompt-injection detection ONLY. PII redaction is intentionally
    // disabled: the user is dictating a rule whose literal values (an amount
    // threshold, a status string, even an email/phone) must survive verbatim
    // so they reach the drafted rule. Redacting them to `[REDACTED_*]` would
    // silently corrupt the rule. Prompt-injection is the security concern here.
    const result = sanitizePrompt(trimmed, { enablePII: false });
    if (result.blocked) {
      return noMatch(
        "blocked_by_sanitizer",
        result.blockReason ?? SCHEMA_INTENT_MESSAGES.blockedBySanitizer,
      );
    }
    utterance = result.sanitized;
  }

  // Step 2 — Build the entity catalog (grounding metadata).
  const catalog = buildEntityCatalog(deps.ontology);
  if (catalog.length === 0) {
    return noMatch("no_entities_in_scope", SCHEMA_INTENT_MESSAGES.noEntitiesInScope);
  }
  const catalogIndex = new Map(catalog.map((entry) => [entry.name, entry]));

  // Step 3 — Build the focused system prompt + compose messages. History is
  // intentionally NOT forwarded (single-shot slice).
  const systemPrompt = buildSchemaIntentSystemPrompt(catalog, minConfidence);
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: utterance },
  ];

  // Step 4 — Call the AI. Any throw is graceful degradation → no_match.
  let rawContent: string;
  try {
    const result = await deps.provider.complete({
      messages,
      temperature: 0,
      tenantId: input.tenantId,
    });
    rawContent = result.content;
  } catch (err) {
    return noMatch(
      "ai_unavailable",
      err instanceof Error
        ? SCHEMA_INTENT_MESSAGES.aiUnavailableWithMessage(err.message)
        : SCHEMA_INTENT_MESSAGES.aiUnavailable,
    );
  }

  // Step 5 — Parse the AI response.
  const parsed = parseSchemaIntentResponse(rawContent);
  if (!parsed) {
    return noMatch("ai_malformed_response", SCHEMA_INTENT_MESSAGES.aiMalformedResponse);
  }

  // Step 6 — Branch on the AI-declared kind.
  if (parsed.kind === "no_match") {
    return noMatch("no_rule_drafted", parsed.explanation || SCHEMA_INTENT_MESSAGES.noRuleDrafted);
  }
  if (parsed.kind === "clarification") {
    return {
      kind: "clarification",
      question:
        parsed.question && parsed.question.trim().length > 0
          ? parsed.question
          : SCHEMA_INTENT_MESSAGES.lowConfidenceClarification,
      bestConfidence: clampConfidence(parsed.confidence),
    };
  }

  // kind === "add_rule" | "update_rule"
  const confidence = clampConfidence(parsed.confidence);
  if (confidence < minConfidence) {
    return {
      kind: "clarification",
      question: SCHEMA_INTENT_MESSAGES.lowConfidenceClarification,
      bestConfidence: confidence,
    };
  }

  // Step 7 — Allowlist the target entity (hallucination defense).
  const targetEntity = parsed.targetEntity ?? "";
  const entity = catalogIndex.get(targetEntity);
  if (!entity) {
    return noMatch("unknown_entity", SCHEMA_INTENT_MESSAGES.unknownEntity(targetEntity));
  }

  // Step 8/9 — update path: reconcile against an EXISTING rule, then mint.
  if (parsed.kind === "update_rule") {
    return draftRuleUpdate({
      parsed,
      entity,
      confidence,
      utterance,
      engine: deps.proposalEngine,
    });
  }

  // Step 8 — Validate + reconcile the proposed rule against the entity.
  const built = buildRuleDefinition(parsed.rule, entity);
  if (!built.ok) {
    return noMatch("invalid_rule", SCHEMA_INTENT_MESSAGES.invalidRule(built.reason));
  }
  const ruleDef = built.rule;

  // Step 9 — Mint the GOVERNED draft Proposal. Status is "draft" — we never
  // submit or apply. The diff target/operation mirror ProposalEngine's own
  // add_rule shape (proposal-engine.ts buildDiff).
  const explanation = parsed.explanation?.trim() || `Add rule "${ruleDef.name}" to ${entity.name}`;
  const reasoning = utterance;

  const proposal = deps.proposalEngine.createProposal({
    type: "add_rule",
    description: explanation,
    reasoning,
    confidence,
    diff: {
      target: "rule",
      operation: "create",
      definition: ruleDef,
      summary: explanation,
    },
  });

  return {
    kind: "proposal_draft",
    proposal,
    operation: "create",
    ruleName: ruleDef.name,
    targetEntity: entity.name,
    confidence,
    explanation,
  };
}

// ── Update-rule reconciliation + mint ────────────────────────

/**
 * Turn a parsed `update_rule` intent into a governed `update_rule` draft
 * Proposal, mirroring the add_rule path's validation discipline:
 *
 *  1. The targeted rule MUST exist on the entity's rule list (allowlist —
 *     the AI cannot update a rule it was not shown).
 *  2. Round-trippable declarative rule: the AI's FULL updated definition
 *     passes the same strict structural validation as add_rule
 *     (`buildRuleDefinition`); `priority` and unchanged effect fields are
 *     BACK-FILLED from the existing snapshot (robust against AI omissions),
 *     and the name is pinned to the existing rule's name (renames out of
 *     scope) — re-pinned AFTER the build so name normalization can never
 *     diverge from the registered name.
 *  3. Non-round-trippable rule (CODE condition, composite/not condition,
 *     non-action trigger, non-declarative effect): the builder cannot rebuild
 *     the definition faithfully, so none is fabricated. The draft carries
 *     ONLY the human-readable diff summary and is flagged
 *     `requiresCodeChange` — an honest, governed change REQUEST a developer
 *     applies in source. Such an update without any diff/explanation is
 *     refused (there is nothing actionable to review).
 */
function draftRuleUpdate(opts: {
  parsed: ParsedSchemaIntent;
  entity: SchemaIntentEntity;
  confidence: number;
  utterance: string;
  engine: ProposalEngine;
}): SchemaIntentOutcome {
  const { parsed, entity, confidence, utterance, engine } = opts;

  const targetRuleName = (parsed.ruleName ?? "").trim();
  const existing = (entity.rules ?? []).find((rule) => rule.name === targetRuleName);
  if (!existing) {
    return noMatch("unknown_rule", SCHEMA_INTENT_MESSAGES.unknownRule(targetRuleName, entity.name));
  }

  const explanation =
    parsed.explanation?.trim() || `Update rule "${existing.name}" on ${entity.name}`;
  const diffSummary = parsed.diff?.trim() || "";

  // Diff-only path: code-backed rules AND declarative rules the builder
  // cannot rebuild faithfully (composite/not conditions, non-action triggers,
  // non-declarative effects — `roundTrippable: false` in the snapshot). A
  // declarative rebuild of those would silently flatten conjuncts or swap the
  // trigger kind, so the honest draft carries the diff summary only.
  if (existing.conditionKind === "code" || existing.roundTrippable === false) {
    // Honest path for non-round-trippable rules: no fabricated definition.
    const summary = diffSummary || parsed.explanation?.trim() || "";
    if (!summary) {
      return noMatch("invalid_rule", SCHEMA_INTENT_MESSAGES.missingUpdateDiff);
    }
    const proposal = engine.createProposal({
      type: "update_rule",
      description: explanation,
      reasoning: utterance,
      confidence,
      // NO definition — the rule cannot be rebuilt faithfully from what the
      // AI saw. The summary is the reviewable spec of the change.
      // `targetName` carries the rule name so downstream security change
      // records still report the real target without a definition.
      diff: { target: "rule", operation: "update", targetName: existing.name, summary },
    });
    return {
      kind: "proposal_draft",
      proposal,
      operation: "update",
      ruleName: existing.name,
      targetEntity: entity.name,
      confidence,
      explanation,
      diffSummary: summary,
      requiresCodeChange: true,
    };
  }

  // Declarative rule — same strict structural validation as add_rule. The
  // name is pinned to the EXISTING rule's name before validation so an
  // AI-side rename (out of scope) can never slip through as a new rule, and
  // `priority` / unchanged effect fields are back-filled from the existing
  // snapshot so an AI omission never silently resets them.
  const built = buildRuleDefinition(
    parsed.rule ? backfillUpdateShape(parsed.rule, existing) : undefined,
    entity,
  );
  if (!built.ok) {
    return noMatch("invalid_rule", SCHEMA_INTENT_MESSAGES.invalidRule(built.reason));
  }
  // Re-pin AFTER the build: `normalizeRuleName` runs inside the builder, so a
  // registered name that normalization would alter could otherwise make the
  // built name diverge from the pinned target. The governed change must name
  // the EXISTING rule, always.
  const ruleDef: RuleDefinition = { ...built.rule, name: existing.name };
  const summary = diffSummary || explanation;
  const proposal = engine.createProposal({
    type: "update_rule",
    description: explanation,
    reasoning: utterance,
    confidence,
    diff: {
      target: "rule",
      operation: "update",
      definition: ruleDef,
      targetName: existing.name,
      summary,
    },
  });
  return {
    kind: "proposal_draft",
    proposal,
    operation: "update",
    ruleName: ruleDef.name,
    targetEntity: entity.name,
    confidence,
    explanation,
    diffSummary: summary,
  };
}

/**
 * Merge the AI-returned update shape with the EXISTING rule snapshot so
 * fields the AI did not change survive verbatim (review-integrity — the
 * persisted definition must match the human-readable diff):
 *
 *  - `name` is pinned to the existing rule's name (renames out of scope).
 *  - `priority` falls back to the existing value when the AI omits it.
 *  - Effect payload: when the AI omits the effect entirely the existing
 *    payload is used verbatim; when the AI keeps the SAME effect type (or
 *    omits `type` — a partial update payload), payload fields it omitted
 *    (message / level / setFields) are back-filled from the snapshot, and
 *    `setFields` merges ONE level deep so a partial setFields (only the
 *    changed keys) never silently drops the snapshot's other entries. A
 *    deliberate effect-type change is passed through unmerged (the builder
 *    validates its required fields).
 */
function backfillUpdateShape(rule: ParsedRuleShape, existing: SchemaIntentRule): ParsedRuleShape {
  const out: ParsedRuleShape = { ...rule, name: existing.name };
  if (out.priority === undefined && existing.priority !== undefined) {
    out.priority = existing.priority;
  }
  const existingEffect = existing.effect;
  if (existingEffect) {
    if (out.effect === undefined) {
      out.effect = { ...existingEffect };
    } else if (typeof out.effect === "object" && out.effect !== null) {
      const aiEffect = out.effect as Record<string, unknown>;
      // Merge when the AI kept the same effect type OR omitted `type`
      // entirely (a partial payload). A type CHANGE skips the merge so
      // stale fields never leak into the new effect shape.
      if (aiEffect.type === undefined || aiEffect.type === existingEffect.type) {
        const merged: Record<string, unknown> = {
          ...existingEffect,
          ...aiEffect,
          // The merge only runs for same-or-omitted type, so the existing
          // type always wins (covers an explicit `type: undefined` too).
          type: existingEffect.type,
        };
        // `setFields` back-fills one level deep: a partial AI payload
        // carrying only the changed keys must not REPLACE the snapshot's
        // whole map (that would silently drop untouched entries).
        if (isPlainRecord(existingEffect.setFields) && isPlainRecord(aiEffect.setFields)) {
          merged.setFields = { ...existingEffect.setFields, ...aiEffect.setFields };
        }
        out.effect = merged;
      }
    }
  }
  return out;
}

/** Narrow to a plain object record (not null, not an array). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Catalog construction ─────────────────────────────────────

function buildEntityCatalog(ontology: SchemaIntentOntology): SchemaIntentEntity[] {
  const catalog: SchemaIntentEntity[] = [];
  for (const name of ontology.listEntities()) {
    const entity = ontology.describeEntity(name);
    if (entity) catalog.push(entity);
  }
  return catalog;
}

// ── Small helpers ────────────────────────────────────────────

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function noMatch(
  reason: Extract<SchemaIntentOutcome, { kind: "no_match" }>["reason"],
  message: string,
): SchemaIntentOutcome {
  return { kind: "no_match", reason, message };
}
