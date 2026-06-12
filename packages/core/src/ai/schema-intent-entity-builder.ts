/**
 * Schema Intent Resolver — Entity reconciliation + validation
 * (Spec 52 "说→有", entity-creation slice — issue #575).
 *
 * The governed sibling of `schema-intent-rule-builder.ts`: where that module
 * validates an AI-proposed `defineRule()`, THIS module validates an AI-proposed
 * `defineEntity()` (+ an optional first-class `defineRelation()` to an existing
 * entity). Extracted into its own file so the resolver stays under the repo's
 * 500-line ceiling and focuses on the pipeline (sanitize → call AI → mint
 * Proposal).
 *
 * Security posture (mirrors the rule builder):
 *  - The proposed entity name, field set, and relation are validated against a
 *    strict structural allowlist. Raw user text never reaches a privileged
 *    context — only validated, typed values become the Proposal definition.
 *  - System fields (`id`, `tenant_id`, `created_at`, `updated_at`, `created_by`,
 *    `updated_by`, `_version`, `deleted_at`) are server-managed and are REFUSED
 *    if the AI declares them (Spec convention: "System fields are server-managed,
 *    never client-settable").
 *  - The relation's `from` endpoint MUST be an existing entity in the ontology;
 *    its `to` endpoint MUST be the new entity being drafted. An invented
 *    endpoint is refused even after a successful jailbreak.
 */

import type { FieldDefinition, FieldType } from "../types/entity";
import type { RelationCardinality, RelationDefinition } from "../types/relation";
import type { ParsedEntityShape, ParsedRelationShape } from "./schema-intent-prompt";
import { asNonEmptyString, isSnakeCaseName, normalizeRuleName } from "./schema-intent-rule-builder";
import type {
  SchemaIntentEntityFieldDraft,
  SchemaIntentOntology,
  SchemaIntentRelationDraft,
} from "./schema-intent-types";

// ── Allowlists (structural validation) ───────────────────────

/** Field types accepted for an AI-drafted entity field. */
const ALLOWED_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
  "json",
]);

/** Relation cardinalities accepted for an AI-drafted relation. */
const ALLOWED_CARDINALITIES: ReadonlySet<RelationCardinality> = new Set<RelationCardinality>([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
]);

/**
 * System fields (Spec convention) that are server-managed and must NEVER be
 * declared by an AI-drafted entity. Declaring one is a hard validation failure
 * (not a silent drop) so the user sees exactly why the draft was refused.
 */
const SYSTEM_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "deleted_at",
]);

/** Upper bound on drafted fields — a guard against a runaway AI response. */
const MAX_ENTITY_FIELDS = 50;

// ── Public result type ───────────────────────────────────────

/** The validated, typed output of `buildEntityDefinition`. */
export interface BuiltEntityDraft {
  /** snake_case singular entity name. */
  entityName: string;
  /** The typed EntityDefinition that becomes the Proposal definition. */
  definition: {
    name: string;
    label: string;
    description?: string;
    fields: Record<string, FieldDefinition>;
  };
  /** The field drafts (for the structured outcome / review card). */
  fieldDrafts: SchemaIntentEntityFieldDraft[];
  /** Optional validated relation to an existing entity. */
  relation?: { draft: SchemaIntentRelationDraft; definition: RelationDefinition };
}

export type BuildEntityResult =
  | { ok: true; value: BuiltEntityDraft }
  | { ok: false; reason: string };

/**
 * Validate the AI-proposed entity (+ optional relation) against a strict
 * structural allowlist and the ontology, returning a typed `EntityDefinition`
 * (+ `RelationDefinition`). Only validated, structured values reach the
 * Proposal — raw user text is never passed through as code.
 */
export function buildEntityDefinition(
  entity: ParsedEntityShape | undefined,
  relationRaw: ParsedRelationShape | undefined,
  ontology: SchemaIntentOntology,
): BuildEntityResult {
  if (!entity) return { ok: false, reason: "missing entity body" };

  // ── Entity name: snake_case, singular-ish (we don't depluralize, just
  // enforce the identifier shape and reject an existing-entity collision). ──
  const entityName = normalizeRuleName(entity.name);
  if (!entityName || !isSnakeCaseName(entityName)) {
    return { ok: false, reason: "entity name must be a non-empty snake_case identifier" };
  }
  // Refuse re-declaring an existing entity (this resolver CREATES, never edits).
  if (ontology.describeEntity(entityName)) {
    return { ok: false, reason: `entity "${entityName}" already exists` };
  }

  const label = asNonEmptyString(entity.label) ?? entityName;
  const description = asNonEmptyString(entity.description);

  // ── Fields ──
  const fieldsRaw = Array.isArray(entity.fields) ? entity.fields : undefined;
  if (!fieldsRaw || fieldsRaw.length === 0) {
    return { ok: false, reason: "entity must declare at least one field" };
  }
  if (fieldsRaw.length > MAX_ENTITY_FIELDS) {
    return { ok: false, reason: `entity declares too many fields (max ${MAX_ENTITY_FIELDS})` };
  }

  const fieldDrafts: SchemaIntentEntityFieldDraft[] = [];
  const fieldDefs: Record<string, FieldDefinition> = {};
  const seen = new Set<string>();
  for (const raw of fieldsRaw) {
    const built = buildField(raw);
    if (!built.ok) return { ok: false, reason: built.reason };
    const { draft, definition } = built.value;
    if (seen.has(draft.name)) {
      return { ok: false, reason: `duplicate field "${draft.name}"` };
    }
    seen.add(draft.name);
    fieldDrafts.push(draft);
    fieldDefs[draft.name] = definition;
  }

  // ── Optional relation ──
  let relation: BuiltEntityDraft["relation"];
  if (relationRaw !== undefined && relationRaw !== null) {
    const built = buildRelation(relationRaw, entityName, ontology);
    if (!built.ok) return { ok: false, reason: built.reason };
    relation = built.value;
  }

  return {
    ok: true,
    value: {
      entityName,
      definition: {
        name: entityName,
        label,
        ...(description ? { description } : {}),
        fields: fieldDefs,
      },
      fieldDrafts,
      ...(relation ? { relation } : {}),
    },
  };
}

// ── Field validation ─────────────────────────────────────────

type FieldResult =
  | { ok: true; value: { draft: SchemaIntentEntityFieldDraft; definition: FieldDefinition } }
  | { ok: false; reason: string };

function buildField(raw: unknown): FieldResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "each field must be an object" };
  }
  const rec = raw as Record<string, unknown>;

  const name = normalizeRuleName(rec.name);
  if (!name || !isSnakeCaseName(name)) {
    return { ok: false, reason: "field name must be a non-empty snake_case identifier" };
  }
  if (SYSTEM_FIELD_NAMES.has(name)) {
    return {
      ok: false,
      reason: `field "${name}" is a server-managed system field and cannot be declared`,
    };
  }

  const typeStr = asNonEmptyString(rec.type);
  if (!typeStr || !ALLOWED_FIELD_TYPES.has(typeStr as FieldType)) {
    return { ok: false, reason: `field "${name}" has an unsupported type "${String(rec.type)}"` };
  }
  const type = typeStr as FieldType;
  const required = rec.required === true;
  const label = asNonEmptyString(rec.label);

  const draft: SchemaIntentEntityFieldDraft = { name, type, required };
  if (label) draft.label = label;

  // `unique` is meaningful for scalar fields (e.g. a barcode). Carry it through.
  const unique = rec.unique === true;
  if (unique) draft.unique = true;

  // Numeric bounds (e.g. 箱规 case_pack_quantity ≥ 1). Only for `number`.
  if (type === "number") {
    if (typeof rec.min === "number" && Number.isFinite(rec.min)) draft.min = rec.min;
    if (typeof rec.max === "number" && Number.isFinite(rec.max)) draft.max = rec.max;
  }

  // Enum options.
  let options: Array<{ value: string; label?: string }> | undefined;
  if (type === "enum") {
    const built = buildEnumOptions(rec.options);
    if (!built.ok) return { ok: false, reason: `field "${name}" ${built.reason}` };
    options = built.value;
    draft.options = options.map((o) => o.value);
  }

  // Build the typed FieldDefinition (only validated values reach here).
  const base = {
    type,
    label: label ?? name,
    ...(required ? { required: true } : {}),
    ...(unique ? { unique: true } : {}),
  };
  let definition: FieldDefinition;
  if (type === "enum") {
    definition = { ...base, type: "enum", options: options ?? [] };
  } else if (type === "number") {
    definition = {
      ...base,
      type: "number",
      ...(draft.min !== undefined ? { min: draft.min } : {}),
      ...(draft.max !== undefined ? { max: draft.max } : {}),
    };
  } else {
    // string / text / boolean / date / datetime / json all share BaseFieldDefinition.
    definition = { ...base, type } as FieldDefinition;
  }

  return { ok: true, value: { draft, definition } };
}

type EnumResult =
  | { ok: true; value: Array<{ value: string; label?: string }> }
  | { ok: false; reason: string };

function buildEnumOptions(raw: unknown): EnumResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "of type enum requires a non-empty options array" };
  }
  const out: Array<{ value: string; label?: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // Accept either a bare string or an { value, label } object.
    let value: string | undefined;
    let optLabel: string | undefined;
    if (typeof item === "string") {
      value = normalizeRuleName(item);
      optLabel = asNonEmptyString(item);
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      value = normalizeRuleName(obj.value);
      optLabel = asNonEmptyString(obj.label) ?? asNonEmptyString(obj.value);
    }
    if (!value || !isSnakeCaseName(value)) {
      return { ok: false, reason: "has an enum option that is not a valid snake_case value" };
    }
    if (seen.has(value)) continue; // drop duplicate option values
    seen.add(value);
    out.push(optLabel && optLabel !== value ? { value, label: optLabel } : { value });
  }
  if (out.length === 0) {
    return { ok: false, reason: "of type enum requires at least one valid option" };
  }
  return { ok: true, value: out };
}

// ── Relation validation ──────────────────────────────────────

type RelationResult =
  | { ok: true; value: { draft: SchemaIntentRelationDraft; definition: RelationDefinition } }
  | { ok: false; reason: string };

function buildRelation(
  raw: ParsedRelationShape,
  newEntityName: string,
  ontology: SchemaIntentOntology,
): RelationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "relation must be an object" };
  }

  const from = normalizeRuleName(raw.from);
  if (!from || !isSnakeCaseName(from)) {
    return { ok: false, reason: "relation.from must be a snake_case entity name" };
  }
  // `from` MUST be an existing entity (the new entity is the relation target).
  if (!ontology.describeEntity(from)) {
    return { ok: false, reason: `relation.from "${from}" is not an existing entity` };
  }

  const to = normalizeRuleName(raw.to);
  if (!to) {
    return { ok: false, reason: "relation.to must be a snake_case entity name" };
  }
  // `to` MUST be the new entity being drafted (this resolver only links INTO
  // the entity it is creating; linking two existing entities is out of scope).
  if (to !== newEntityName) {
    return {
      ok: false,
      reason: `relation.to "${to}" must be the new entity "${newEntityName}"`,
    };
  }

  const cardStr = asNonEmptyString(raw.cardinality);
  if (!cardStr || !ALLOWED_CARDINALITIES.has(cardStr as RelationCardinality)) {
    return {
      ok: false,
      reason: `relation.cardinality "${String(raw.cardinality)}" is not allowed`,
    };
  }
  const cardinality = cardStr as RelationCardinality;

  // Semantic navigation names. Default them from the entity names when absent.
  const fromName = normalizeRuleName(raw.fromName) ?? to;
  const toName = normalizeRuleName(raw.toName) ?? `${from}s`;
  if (!isSnakeCaseName(fromName) || !isSnakeCaseName(toName)) {
    return { ok: false, reason: "relation fromName / toName must be snake_case identifiers" };
  }

  const name = normalizeRuleName(raw.name) ?? `${from}_${to}`;
  if (!isSnakeCaseName(name)) {
    return { ok: false, reason: "relation.name must be a snake_case identifier" };
  }

  const draft: SchemaIntentRelationDraft = {
    name,
    from,
    to,
    cardinality,
    fromName,
    toName,
  };
  const definition: RelationDefinition = {
    name,
    from,
    to,
    cardinality,
    fromName,
    toName,
  };
  return { ok: true, value: { draft, definition } };
}
