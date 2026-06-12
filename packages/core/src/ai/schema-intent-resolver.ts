/**
 * Schema Intent Resolver — NL utterance → governed `add_rule` / `update_rule`
 * ProposalDraft (Spec 52 "describe-to-exists").
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
import { sanitizePrompt } from "./prompt-sanitizer";
import type { ProposalEngine } from "./proposal-engine";
// Entity reconciliation + validation lives in a sibling module so this file
// stays under the 500-line ceiling and focuses on the pipeline.
import { buildEntityDefinition } from "./schema-intent-entity-builder";
// System prompt + response parser live in a sibling module (mirrors the
// intent-resolver.ts / intent-prompt.ts split) so this file stays focused on
// the pipeline + the governed Proposal mint.
import type { ParsedSchemaIntent } from "./schema-intent-prompt";
import { buildSchemaIntentSystemPrompt, parseSchemaIntentResponse } from "./schema-intent-prompt";
// Tunable defaults + user-facing messages live in a leaf module so the
// reconciliation siblings can share them without a circular import.
import {
  SCHEMA_INTENT_MESSAGES,
  SCHEMA_INTENT_MIN_CONFIDENCE,
} from "./schema-intent-resolver-messages";
// Rule reconciliation + validation lives in a sibling module so this file
// stays under the 500-line ceiling and focuses on the pipeline.
import { buildRuleDefinition } from "./schema-intent-rule-builder";
// Update-rule reconciliation lives in its own sibling module (same ceiling
// discipline) — the resolver just routes to it.
import { draftRuleUpdate } from "./schema-intent-rule-updater";
import type {
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentOutcome,
  SchemaIntentResolverOptions,
} from "./schema-intent-types";

// ── Re-exports (preserve the public API surface) ─────────────

export {
  REQUIRES_CODE_CHANGE_MARKER,
  SCHEMA_INTENT_MESSAGES,
  SCHEMA_INTENT_MIN_CONFIDENCE,
  type SchemaIntentMessages,
} from "./schema-intent-resolver-messages";

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

  // Step 2 — Build the entity catalog (grounding metadata). An EMPTY catalog is
  // NOT rejected here: `add_entity` must work on a fresh, zero-entity deployment
  // (the 说→有 first-entity case). The empty-catalog guard is applied later, only
  // to the rule paths, which always need an existing target entity.
  const catalog = buildEntityCatalog(deps.ontology);
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
    // Multi-intent guard (issue #575): when the AI flagged BOTH an entity and a
    // rule intent, surface a structured clarification (detected intents +
    // confirm-scope question) instead of a generic low-confidence prompt — never
    // a silent no_match. True multi-part proposals are deferred to a follow-up.
    const detectedIntents = normalizeDetectedIntents(parsed.detectedIntents);
    const isMultiIntent = detectedIntents !== undefined && detectedIntents.length >= 2;
    return {
      kind: "clarification",
      question:
        parsed.question && parsed.question.trim().length > 0
          ? parsed.question
          : isMultiIntent
            ? SCHEMA_INTENT_MESSAGES.multiIntentClarification
            : SCHEMA_INTENT_MESSAGES.lowConfidenceClarification,
      bestConfidence: clampConfidence(parsed.confidence),
      ...(detectedIntents ? { detectedIntents } : {}),
    };
  }

  // Entity-creation branch (issue #575). Mirrors the rule path: gate on
  // confidence, validate against the ontology, mint a GOVERNED draft.
  if (parsed.kind === "add_entity") {
    return resolveAddEntity(parsed, deps, minConfidence, utterance);
  }

  // kind === "add_rule" | "update_rule": both target an EXISTING entity, so an
  // empty catalog cannot satisfy them (unlike add_entity, handled above).
  if (catalog.length === 0) {
    return noMatch("no_entities_in_scope", SCHEMA_INTENT_MESSAGES.noEntitiesInScope);
  }
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

// ── Entity-creation branch (issue #575) ──────────────────────

/**
 * Resolve an AI-declared `add_entity` intent into a governed `add_entity`
 * Proposal draft. Mirrors the rule path: gate on confidence, run strict
 * structural validation against the ontology (snake_case singular name, no
 * system-field collisions, valid field types, valid relation endpoints), then
 * mint a GOVERNED `modify_schema` Proposal whose `diff.target === "entity"`.
 * The Proposal is ALWAYS `draft` — never submitted or applied here.
 */
function resolveAddEntity(
  parsed: ParsedSchemaIntent,
  deps: ResolveSchemaIntentDeps,
  minConfidence: number,
  utterance: string,
): SchemaIntentOutcome {
  const confidence = clampConfidence(parsed.confidence);
  if (confidence < minConfidence) {
    return {
      kind: "clarification",
      // Entity-specific wording: this branch is only reached for an `add_entity`
      // intent, so the rule-oriented `lowConfidenceClarification` ("what rule…
      // what condition") would be confusing — the user asked to create a record
      // type, not a rule.
      question: SCHEMA_INTENT_MESSAGES.lowConfidenceEntityClarification,
      bestConfidence: confidence,
    };
  }

  // Validate + reconcile the proposed entity (+ optional relation) against the
  // ontology. Only validated, typed values reach the Proposal.
  const built = buildEntityDefinition(parsed.entity, parsed.relation, deps.ontology);
  if (!built.ok) {
    return noMatch("invalid_entity", SCHEMA_INTENT_MESSAGES.invalidEntity(built.reason));
  }
  const { entityName, definition, fieldDrafts, relation } = built.value;

  const explanation = parsed.explanation?.trim() || `Add entity "${entityName}"`;
  const reasoning = utterance;

  // The governed entity Proposal is a `modify_schema`-typed change whose diff
  // target is "entity" (ProposalEngine already models entity targets — we reuse
  // it, no parallel diff model). The relation rides along inside the definition
  // so the downstream code generator can emit both defineEntity() + defineRelation().
  const proposal = deps.proposalEngine.createProposal({
    type: "modify_schema",
    description: explanation,
    reasoning,
    confidence,
    diff: {
      target: "entity",
      operation: "create",
      definition: {
        ...definition,
        ...(relation ? { relation: relation.definition } : {}),
      },
      summary: explanation,
    },
  });

  return {
    kind: "entity_proposal_draft",
    proposal,
    entityName,
    fields: fieldDrafts,
    ...(relation ? { relation: relation.draft } : {}),
    confidence,
    explanation,
  };
}

/** Narrow + dedupe the AI-reported detectedIntents to the known intent labels. */
function normalizeDetectedIntents(
  raw: Array<"add_entity" | "add_rule"> | undefined,
): Array<"add_entity" | "add_rule"> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: Array<"add_entity" | "add_rule"> = [];
  for (const item of raw) {
    if ((item === "add_entity" || item === "add_rule") && !out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
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
