/**
 * Schema Intent Resolver — NL utterance → governed `add_rule` ProposalDraft
 * (Spec 52 "说→有", first slice).
 *
 * The bridge that was missing: the existing `resolveIntent()` (intent-
 * resolver.ts) turns an utterance into a RUNTIME DATA action; this resolver
 * turns an utterance into a METAMODEL CHANGE — specifically a new
 * `defineRule()` — surfaced ONLY as a governed `add_rule` Proposal in
 * `draft` status via `ProposalEngine.createProposal()`.
 *
 * Pipeline (mirrors intent-resolver.ts):
 *   sanitize → build entity catalog → build focused system prompt
 *   → call provider → parse + validate AI JSON → reconcile rule against
 *   the ontology → `ProposalEngine.createProposal({ type: 'add_rule', ... })`
 *   → emit `SchemaIntentOutcome` (proposal_draft / clarification / no_match).
 *
 * Hard rules (repo principle "AI Never Modifies Production Directly"):
 *  - NEVER submits, approves, or applies. The returned Proposal is ALWAYS
 *    `draft`. Graduating it (draft→pending→…) is a separate, human-gated path.
 *  - `add_rule` ONLY. Entity/field/view creation is out of scope (later slices).
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
import type {
  ComparisonOperator,
  DeclarativeCondition,
  RuleDefinition,
  RuleEffect,
  RuleTrigger,
  SimpleCondition,
} from "../types/rule";
import { sanitizePrompt } from "./prompt-sanitizer";
import type { ProposalEngine } from "./proposal-engine";
// System prompt + response parser live in a sibling module (mirrors the
// intent-resolver.ts / intent-prompt.ts split) so this file stays focused on
// reconciliation + the governed Proposal mint.
import {
  buildSchemaIntentSystemPrompt,
  type ParsedRuleShape,
  parseSchemaIntentResponse,
} from "./schema-intent-prompt";
import type {
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentOutcome,
  SchemaIntentResolverOptions,
} from "./schema-intent-types";

// ── Tunable defaults ─────────────────────────────────────────

/** Confidence floor below which we ask a clarifying question instead of drafting. */
export const SCHEMA_INTENT_MIN_CONFIDENCE = 0.4;

// ── Allowlists (structural validation) ───────────────────────

/** Comparison operators accepted in a proposed rule condition. */
const ALLOWED_OPERATORS: ReadonlySet<ComparisonOperator> = new Set<ComparisonOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "is_null",
  "not_null",
  "contains",
  "notContains",
  "between",
  "notBetween",
  "startsWith",
  "endsWith",
  "includesAll",
  "excludesAny",
]);

/** Effect types accepted for a drafted rule. */
const ALLOWED_EFFECT_TYPES: ReadonlySet<RuleEffect["type"]> = new Set<RuleEffect["type"]>([
  "block",
  "warn",
  "require_approval",
  "enrich",
]);

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
  invalidRule: (detail: string) => `AI proposed an invalid rule: ${detail}.`,
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
    const result = sanitizePrompt(trimmed);
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

  // kind === "add_rule"
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
    ruleName: ruleDef.name,
    targetEntity: entity.name,
    confidence,
    explanation,
  };
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

// ── Rule reconciliation + validation ─────────────────────────

type BuildRuleResult = { ok: true; rule: RuleDefinition } | { ok: false; reason: string };

/**
 * Validate the AI-proposed rule against a strict structural allowlist and the
 * target entity's field set, then return a typed `RuleDefinition`. Only
 * validated, structured values reach the Proposal — raw user text is never
 * passed through as code.
 */
function buildRuleDefinition(
  rule: ParsedRuleShape | undefined,
  entity: SchemaIntentEntity,
): BuildRuleResult {
  if (!rule) return { ok: false, reason: "missing rule body" };

  const name = asNonEmptyString(rule.name);
  if (!name || !isSnakeCaseName(name)) {
    return { ok: false, reason: "rule name must be a non-empty snake_case identifier" };
  }

  const label = asNonEmptyString(rule.label) ?? name;
  const description = asNonEmptyString(rule.description);
  const priority =
    typeof rule.priority === "number" && Number.isFinite(rule.priority)
      ? Math.trunc(rule.priority)
      : undefined;

  const trigger = buildTrigger(rule.trigger, entity);
  if (!trigger.ok) return { ok: false, reason: trigger.reason };

  const condition = buildCondition(rule.condition, entity);
  if (!condition.ok) return { ok: false, reason: condition.reason };

  const effect = buildEffect(rule.effect, entity);
  if (!effect.ok) return { ok: false, reason: effect.reason };

  const def: RuleDefinition = {
    name,
    label,
    ...(description ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    trigger: trigger.value,
    condition: condition.value,
    effect: effect.value,
  };
  return { ok: true, rule: def };
}

type TriggerResult = { ok: true; value: RuleTrigger } | { ok: false; reason: string };

function buildTrigger(raw: unknown, entity: SchemaIntentEntity): TriggerResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "trigger must be an object with an action" };
  }
  const rec = raw as Record<string, unknown>;
  const action = asNonEmptyString(rec.action);
  if (!action) {
    return { ok: false, reason: "trigger.action must be a non-empty string" };
  }
  // Allow either a known action on the entity or the canonical create_<entity>.
  const isKnownAction = entity.actionNames.includes(action);
  const isCanonicalCreate = action === `create_${entity.name}`;
  if (!isKnownAction && !isCanonicalCreate) {
    return {
      ok: false,
      reason: `trigger.action "${action}" is not an action of entity "${entity.name}"`,
    };
  }
  return { ok: true, value: { action } };
}

type ConditionResult = { ok: true; value: DeclarativeCondition } | { ok: false; reason: string };

function buildCondition(raw: unknown, entity: SchemaIntentEntity): ConditionResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "condition must be an object" };
  }
  const rec = raw as Record<string, unknown>;
  const field = asNonEmptyString(rec.field);
  if (!field) {
    return { ok: false, reason: "condition.field must be a non-empty string" };
  }
  if (!entity.fields.some((f) => f.name === field)) {
    return {
      ok: false,
      reason: `condition.field "${field}" is not a field of entity "${entity.name}"`,
    };
  }
  const operator = rec.operator;
  if (typeof operator !== "string" || !ALLOWED_OPERATORS.has(operator as ComparisonOperator)) {
    return { ok: false, reason: `condition.operator "${String(operator)}" is not allowed` };
  }
  const op = operator as ComparisonOperator;
  // is_null / not_null take no value; everything else requires one.
  const valueless = op === "is_null" || op === "not_null";
  const condition: SimpleCondition = { field, operator: op };
  if (!valueless) {
    if (rec.value === undefined) {
      return { ok: false, reason: `condition.value is required for operator "${op}"` };
    }
    condition.value = rec.value;
  }
  return { ok: true, value: condition };
}

type EffectResult = { ok: true; value: RuleEffect } | { ok: false; reason: string };

function buildEffect(raw: unknown, entity: SchemaIntentEntity): EffectResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "effect must be an object with a type" };
  }
  const rec = raw as Record<string, unknown>;
  const type = rec.type;
  if (typeof type !== "string" || !ALLOWED_EFFECT_TYPES.has(type as RuleEffect["type"])) {
    return { ok: false, reason: `effect.type "${String(type)}" is not allowed` };
  }

  switch (type as RuleEffect["type"]) {
    case "block": {
      const message = asNonEmptyString(rec.message);
      if (!message) return { ok: false, reason: "block effect requires a message" };
      return { ok: true, value: { type: "block", message } };
    }
    case "warn": {
      const message = asNonEmptyString(rec.message);
      if (!message) return { ok: false, reason: "warn effect requires a message" };
      return { ok: true, value: { type: "warn", message } };
    }
    case "require_approval": {
      const level = asNonEmptyString(rec.level);
      if (!level) return { ok: false, reason: "require_approval effect requires a level" };
      const message = asNonEmptyString(rec.message);
      return {
        ok: true,
        value: { type: "require_approval", level, ...(message ? { message } : {}) },
      };
    }
    case "enrich": {
      const setFields = buildEnrichSetFields(rec.setFields, entity);
      if (!setFields.ok) return setFields;
      return { ok: true, value: { type: "enrich", setFields: setFields.value } };
    }
    // `execute_action` is intentionally NOT accepted in this slice — drafting
    // a rule that triggers another action widens the blast radius beyond
    // "add a guard/validation" and needs its own review path.
    default:
      return { ok: false, reason: `effect.type "${type}" is not supported in this slice` };
  }
}

type EnrichResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

function buildEnrichSetFields(raw: unknown, entity: SchemaIntentEntity): EnrichResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "enrich effect requires a setFields object" };
  }
  const known = new Set(entity.fields.map((f) => f.name));
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Drop fields that do not exist on the entity (hallucination defense).
    if (!known.has(key)) continue;
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: false, reason: "enrich effect setFields referenced no known fields" };
  }
  return { ok: true, value: cleaned };
}

// ── Small helpers ────────────────────────────────────────────

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** snake_case identifier: lowercase letters/digits/underscores, starts with a letter. */
function isSnakeCaseName(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

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
