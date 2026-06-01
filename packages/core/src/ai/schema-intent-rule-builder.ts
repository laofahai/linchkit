/**
 * Schema Intent Resolver — Rule reconciliation + validation
 * (Spec 52 "说→有", first slice).
 *
 * Extracted from `schema-intent-resolver.ts` so the resolver file stays under
 * the repo's 500-line ceiling and focuses on the pipeline (sanitize → call AI →
 * mint Proposal). This module owns the strict structural validation that turns
 * the untyped AI-proposed rule into a typed `RuleDefinition`.
 *
 * Security posture (same as the resolver doc):
 *  - The proposed `trigger` / `condition` / `effect` are validated against a
 *    strict structural allowlist; the `field` referenced by a condition must
 *    exist on the target entity. Raw user text is never interpolated into a
 *    privileged context — only validated, structured values reach the Proposal.
 *  - `condition.value` is coerced to the target field's declared type so a
 *    string-typed AI value (e.g. `"10000"`) never reaches rule evaluation as
 *    the wrong runtime type (Spec 52 review — type-safety hardening).
 */

import type {
  ComparisonOperator,
  DeclarativeCondition,
  RuleDefinition,
  RuleEffect,
  RuleTrigger,
  SimpleCondition,
} from "../types/rule";
import type { ParsedRuleShape } from "./schema-intent-prompt";
import type { SchemaIntentEntity } from "./schema-intent-types";

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

/** Operators whose value is (or may be) a collection rather than a scalar. */
const COLLECTION_OPERATORS: ReadonlySet<ComparisonOperator> = new Set<ComparisonOperator>([
  "in",
  "not_in",
  "between",
  "notBetween",
  "includesAll",
  "excludesAny",
]);

// ── Public result type ───────────────────────────────────────

export type BuildRuleResult = { ok: true; rule: RuleDefinition } | { ok: false; reason: string };

/**
 * Validate the AI-proposed rule against a strict structural allowlist and the
 * target entity's field set, then return a typed `RuleDefinition`. Only
 * validated, structured values reach the Proposal — raw user text is never
 * passed through as code.
 */
export function buildRuleDefinition(
  rule: ParsedRuleShape | undefined,
  entity: SchemaIntentEntity,
): BuildRuleResult {
  if (!rule) return { ok: false, reason: "missing rule body" };

  const name = normalizeRuleName(rule.name);
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
  const fieldDef = entity.fields.find((f) => f.name === field);
  if (!fieldDef) {
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
    // Coerce the value to the field's declared type so a string-typed AI value
    // (e.g. "10000" for a numeric field) never reaches rule evaluation as the
    // wrong runtime type. Collection operators take an array of values.
    const coerced = coerceConditionValue(rec.value, fieldDef.type, op);
    if (!coerced.ok) {
      return { ok: false, reason: `condition.value ${coerced.reason}` };
    }
    condition.value = coerced.value;
  }
  return { ok: true, value: condition };
}

type CoerceResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Coerce a raw AI-supplied condition value to the field's declared type.
 *  - `number` / `state`-with-numeric: accept a number or a numeric string.
 *  - `boolean`: accept a boolean or "true"/"false".
 *  - `string` / `text` / `enum` / `state` / `date` / `datetime`: stringify
 *    scalars; reject objects.
 *  - `json`: pass through unchanged.
 * Collection operators (`in`, `between`, …) coerce each array element with the
 * same scalar rules; a non-array value for a collection operator is rejected.
 */
function coerceConditionValue(
  raw: unknown,
  fieldType: string,
  operator: ComparisonOperator,
): CoerceResult {
  if (COLLECTION_OPERATORS.has(operator)) {
    if (!Array.isArray(raw)) {
      return { ok: false, reason: `must be an array for operator "${operator}"` };
    }
    const out: unknown[] = [];
    for (const element of raw) {
      const elem = coerceScalar(element, fieldType);
      if (!elem.ok) return elem;
      out.push(elem.value);
    }
    return { ok: true, value: out };
  }
  return coerceScalar(raw, fieldType);
}

function coerceScalar(raw: unknown, fieldType: string): CoerceResult {
  // `json` fields accept arbitrary structured values unchanged.
  if (fieldType === "json") return { ok: true, value: raw };

  if (fieldType === "number") {
    if (typeof raw === "number") {
      return Number.isFinite(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: "must be a finite number" };
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return { ok: false, reason: "must be a number, got empty string" };
      const num = Number(trimmed);
      return Number.isFinite(num)
        ? { ok: true, value: num }
        : { ok: false, reason: `must be a number, got "${raw}"` };
    }
    return { ok: false, reason: `must be a number, got ${typeof raw}` };
  }

  if (fieldType === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (typeof raw === "string") {
      const lowered = raw.trim().toLowerCase();
      if (lowered === "true") return { ok: true, value: true };
      if (lowered === "false") return { ok: true, value: false };
    }
    return { ok: false, reason: `must be a boolean, got "${String(raw)}"` };
  }

  // String-family fields: string / text / enum / state / date / datetime /
  // computed. Accept scalars (string/number/boolean) and stringify; reject
  // objects/arrays/null which cannot be a scalar comparison value.
  if (typeof raw === "string") return { ok: true, value: raw };
  if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: String(raw) };
  if (typeof raw === "boolean") return { ok: true, value: String(raw) };
  return { ok: false, reason: `must be a string-compatible scalar, got ${typeof raw}` };
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
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Drop fields that do not exist on the entity (hallucination defense).
    const fieldDef = byName.get(key);
    if (!fieldDef) continue;
    if (value === undefined || value === null) continue;
    // Coerce the assigned value to the field's declared type (same hardening as
    // condition.value). An uncoercible assignment drops the field rather than
    // failing the whole rule — enrich is best-effort auto-fill.
    const coerced = coerceScalar(value, fieldDef.type);
    if (!coerced.ok) continue;
    cleaned[key] = coerced.value;
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: false, reason: "enrich effect setFields referenced no known fields" };
  }
  return { ok: true, value: cleaned };
}

// ── Small helpers ────────────────────────────────────────────

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize an AI-proposed rule name to a snake_case identifier. LLMs often
 * emit camelCase / kebab-case / space-separated names; rejecting the whole
 * resolution over a formatting nit is user-hostile, so we lowercase and replace
 * any run of non-`[a-z0-9_]` characters with a single underscore, then trim
 * leading/trailing underscores. Returns `undefined` for a non-string or a value
 * that normalizes to empty (the caller then rejects with a clear reason).
 */
export function normalizeRuleName(value: unknown): string | undefined {
  const base = asNonEmptyString(value);
  if (!base) return undefined;
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

/** snake_case identifier: lowercase letters/digits/underscores, starts with a letter. */
export function isSnakeCaseName(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}
