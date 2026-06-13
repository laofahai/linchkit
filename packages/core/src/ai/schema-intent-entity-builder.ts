/**
 * Schema Intent Resolver — Entity shape validation + draft minting
 * (Spec 52 "说→有", entity-creation slice).
 *
 * Extracted from `schema-intent-resolver.ts` so the resolver file stays under
 * the repo's 500-line ceiling. Owns two concerns:
 *   1. Structural validation of the AI-proposed entity shape (buildEntityDefinition).
 *   2. Translating a validated shape into a governed `add_entity` ProposalDraft
 *      (draftEntityProposal) — kept here to avoid a circular dependency that
 *      would arise if the resolver imported from itself.
 *
 * Security posture:
 *  - Entity and field names are validated against a strict snake_case pattern;
 *    arbitrary strings (labels, description) reach the proposal as opaque
 *    data, never used as identifiers or interpolated into privileged contexts.
 *  - Field types are constrained to an explicit allowlist — unknown types are
 *    rejected rather than passed through.
 *  - Empty or duplicate field names are refused.
 *  - The draft Proposal is always in `draft` status — this module never submits
 *    or applies. Identical guarantee as the rule-resolver path.
 *  - Never throws — every error path returns a `SchemaIntentOutcome`.
 */

import type { ProposalEngine } from "./proposal-engine";
import type { ParsedSchemaIntent } from "./schema-intent-prompt";
import type { SchemaIntentOutcome } from "./schema-intent-types";

// ── Allowlists ───────────────────────────────────────────────

/** Field types the AI may propose for a new entity. */
const ALLOWED_FIELD_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "text",
  "json",
  "decimal",
]);

/** Pattern for valid snake_case identifiers (entity/field names). */
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

// ── Parsed shapes (untyped inputs from AI response) ──────────

/** One field in an AI-proposed entity definition (untyped input). */
export interface ParsedEntityField {
  name?: unknown;
  type?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
}

/** AI-proposed entity definition (untyped input). */
export interface ParsedEntityShape {
  name?: unknown;
  label?: unknown;
  description?: unknown;
  fields?: unknown;
}

// ── Validated output ─────────────────────────────────────────

/** One validated field in the proposed entity. */
export interface ValidatedEntityField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
  description?: string;
}

/** Validated entity definition ready for a `ProposalDiff`. */
export interface ValidatedEntityDefinition {
  name: string;
  label?: string;
  description?: string;
  fields: ValidatedEntityField[];
}

export type BuildEntityResult =
  | { ok: true; definition: ValidatedEntityDefinition }
  | { ok: false; reason: string };

// ── Public API ───────────────────────────────────────────────

/**
 * Validate an AI-proposed entity shape against structural constraints.
 * Returns the typed definition on success or a human-readable reason on
 * failure. Never throws.
 */
export function buildEntityDefinition(shape: ParsedEntityShape | undefined): BuildEntityResult {
  if (!shape || typeof shape !== "object") {
    return { ok: false, reason: "entity definition is missing" };
  }

  // ── Name ──────────────────────────────────────────────────
  const rawName = shape.name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return { ok: false, reason: "entity name is missing or not a string" };
  }
  const name = rawName.trim();
  if (!SNAKE_CASE_RE.test(name)) {
    return {
      ok: false,
      reason: `entity name "${name}" is not valid snake_case (must start with a lowercase letter, contain only [a-z0-9_])`,
    };
  }

  // ── Fields ────────────────────────────────────────────────
  if (!Array.isArray(shape.fields) || shape.fields.length === 0) {
    return { ok: false, reason: "entity must have at least one field" };
  }

  const seen = new Set<string>();
  const fields: ValidatedEntityField[] = [];
  for (let i = 0; i < shape.fields.length; i++) {
    const raw = shape.fields[i] as ParsedEntityField;
    const result = validateField(raw, i);
    if (!result.ok) return result;
    const field = result.field;
    if (seen.has(field.name)) {
      return { ok: false, reason: `duplicate field name "${field.name}"` };
    }
    seen.add(field.name);
    fields.push(field);
  }

  // ── Optional metadata ─────────────────────────────────────
  const label =
    typeof shape.label === "string" && shape.label.trim() ? shape.label.trim() : undefined;
  const description =
    typeof shape.description === "string" && shape.description.trim()
      ? shape.description.trim()
      : undefined;

  return { ok: true, definition: { name, label, description, fields } };
}

// ── Field validation ─────────────────────────────────────────

type FieldResult = { ok: true; field: ValidatedEntityField } | { ok: false; reason: string };

function validateField(raw: ParsedEntityField, index: number): FieldResult {
  const prefix = `field[${index}]`;

  const rawName = raw?.name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return { ok: false, reason: `${prefix}: name is missing or not a string` };
  }
  const fieldName = rawName.trim();
  if (!SNAKE_CASE_RE.test(fieldName)) {
    return {
      ok: false,
      reason: `${prefix}: name "${fieldName}" is not valid snake_case`,
    };
  }

  const rawType = raw?.type;
  if (typeof rawType !== "string" || !ALLOWED_FIELD_TYPES.has(rawType)) {
    return {
      ok: false,
      reason: `${prefix} "${fieldName}": type "${rawType}" is not allowed (use one of: ${[...ALLOWED_FIELD_TYPES].join(", ")})`,
    };
  }

  const required = raw?.required === true;
  const label = typeof raw?.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
  const description =
    typeof raw?.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;

  return { ok: true, field: { name: fieldName, type: rawType, required, label, description } };
}

// ── Entity-proposal draft mint ───────────────────────────────

/**
 * Validate the AI-proposed entity shape and mint a governed `add_entity`
 * ProposalDraft. The entity is a NEW data type: it does NOT exist in the
 * catalog (no catalog lookup). The proposal is always in `draft` status;
 * nothing is submitted or applied.
 *
 * Messages are inlined (not imported from schema-intent-resolver.ts) to
 * avoid a circular dependency: resolver → entity-builder → resolver.
 */
export function draftEntityProposal(opts: {
  parsed: ParsedSchemaIntent;
  confidence: number;
  minConfidence: number;
  utterance: string;
  engine: ProposalEngine;
}): SchemaIntentOutcome {
  const { parsed, confidence, minConfidence, utterance, engine } = opts;

  if (confidence < minConfidence) {
    return {
      kind: "clarification",
      question:
        "I'm not sure what rule you want. Could you describe the condition and what should happen when it matches?",
      bestConfidence: confidence,
    };
  }

  const built = buildEntityDefinition(parsed.entity);
  if (!built.ok) {
    return {
      kind: "no_match",
      reason: "invalid_entity",
      message: `AI proposed an invalid entity: ${built.reason}.`,
    };
  }
  const definition = built.definition;

  const explanation =
    parsed.explanation?.trim() ||
    `Create entity "${definition.name}" with ${definition.fields.length} field(s)`;

  const proposal = engine.createProposal({
    type: "add_entity",
    description: explanation,
    reasoning: utterance,
    confidence,
    diff: {
      target: "entity",
      operation: "create",
      definition: definition as unknown as Record<string, unknown>,
      summary: explanation,
    },
  });

  return {
    kind: "entity_proposal_draft",
    proposal,
    entityName: definition.name,
    fieldNames: definition.fields.map((f) => f.name),
    confidence,
    explanation,
  };
}
