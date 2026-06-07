/**
 * Validation Phase 3 — Compatibility (breaking-reference) checks (Spec 09 §4.5)
 *
 * Phase 3 inspects a proposal's removing/narrowing changes against the CURRENT
 * meta-model (via the OntologyRegistry) and surfaces breaking references: when a
 * change deletes or narrows an element that other definitions still depend on.
 *
 * Spec 09 §3.4 classifies `major` = delete field / change field type / change
 * state machine / delete action. This phase detects the static, statically
 * determinable subset of those:
 *   - delete of an entity field still referenced by a view / rule / relation
 *   - delete of an action / state / relation that has dependents
 *   - update that changes a field's type, drops a previously-required field's
 *     default, or removes an enum value (narrowing)
 *
 * Severity / gating (low-regret):
 *   - DEFAULT: WARN-ONLY. Findings are emitted as `warnings`; `passed` is NOT
 *     affected (status stays "passed"). Zero risk of false-positive blocking.
 *   - GATED: when `strictCompatibility` is true, findings become `errors`
 *     (status "failed" → proposal `passed` = false → blocks).
 *
 * OUT OF SCOPE for this increment (Spec 09 §4.5 also lists, but these require
 * the build/migration pipeline, not static analysis):
 *   - DB migration safety (data loss / constraint breakage)
 *   - Blue-green backward compatibility of generated migrations
 * These are intentionally left to a later Phase 2/3 build-time pass.
 */

import type { OntologyRegistry } from "../ontology/ontology-registry";
import type { EnumField, FieldDefinition } from "../types/entity";
import type { MetaModelElementType } from "../types/meta-semantics";
import type {
  PhaseResult,
  ProposalChange,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";
import type { RuleDefinition } from "../types/rule";

// ── Options ──────────────────────────────────────────────

export interface ValidatePhase3Options {
  /** The proposal's changes to inspect. */
  changes: ProposalChange[];
  /**
   * Read-only semantic view of the CURRENT (pre-change) meta-model. When absent,
   * Phase 3 cannot compute references and degrades to "skipped".
   */
  ontology?: OntologyRegistry;
  /**
   * When true, breaking-reference findings become ERRORS (blocking). Default
   * (false / undefined) → findings are WARNINGS only and do not affect `passed`.
   */
  strictCompatibility?: boolean;
}

// ── Internal finding shape ───────────────────────────────

interface BreakingFinding {
  code: string;
  message: string;
  target?: string;
  field?: string;
}

// ── Entry point ──────────────────────────────────────────

/**
 * Run Phase 3 (compatibility) validation on a proposal's changes.
 *
 * Returns a PhaseResult:
 *  - no ontology in context → status "skipped" (no findings, never throws)
 *  - findings + strictCompatibility=false → status "passed" with `warnings`
 *  - findings + strictCompatibility=true  → status "failed" with `errors`
 */
export function validatePhase3(options: ValidatePhase3Options): PhaseResult {
  const { changes, ontology, strictCompatibility = false } = options;
  const start = Date.now();

  // Degrade gracefully: without the ontology we cannot determine references.
  if (!ontology) {
    return {
      phase: 3,
      status: "skipped",
      errors: [],
      warnings: [],
      duration: Date.now() - start,
    };
  }

  const findings: BreakingFinding[] = [];

  for (const change of changes) {
    if (change.operation === "delete") {
      detectDeletionBreakage(change, ontology, findings);
    } else if (change.operation === "update") {
      detectUpdateNarrowing(change, ontology, findings);
    }
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (strictCompatibility) {
    for (const f of findings) errors.push(f);
  } else {
    for (const f of findings) warnings.push(f);
  }

  // Default warn-only: status is "passed" even with warnings — `passed` is only
  // dragged false when strictCompatibility escalated findings to errors.
  const status: PhaseResult["status"] = errors.length === 0 ? "passed" : "failed";

  return {
    phase: 3,
    status,
    errors,
    warnings,
    duration: Date.now() - start,
  };
}

// ── Deletion breakage detection ──────────────────────────

/**
 * Flag a `delete` change when other definitions still reference the deleted
 * element. Entity-field deletes are handled at field granularity; action /
 * state / relation deletes reuse the OntologyRegistry impact graph.
 */
function detectDeletionBreakage(
  change: ProposalChange,
  ontology: OntologyRegistry,
  findings: BreakingFinding[],
): void {
  switch (change.target) {
    case "entity":
      detectEntityFieldDeletes(change, ontology, findings);
      // A whole-entity delete (no surviving field definition) also breaks any
      // action / view / rule / relation that references the ENTITY itself — not
      // just its fields — so consult the impact graph for the entity node too.
      if (extractFieldNames(change).size === 0) {
        detectElementDeleteImpact(change.name, "entity", ontology, findings);
      }
      break;
    case "action":
      detectElementDeleteImpact(change.name, "action", ontology, findings);
      break;
    case "state":
      detectElementDeleteImpact(change.name, "state", ontology, findings);
      break;
    default:
      // view / event / rule / flow / overlay deletions are not reference
      // *targets* in the dependency graph — nothing downstream breaks.
      // (`relation` is not a ProposalChangeTarget today, so it can't appear here.)
      break;
  }
}

/**
 * An entity `delete` change may carry a partial replacement definition (the
 * surviving fields). When the registry's current entity has fields the proposal
 * no longer includes, those fields are being removed — flag any that are
 * referenced by a view / rule / relation on that entity.
 */
function detectEntityFieldDeletes(
  change: ProposalChange,
  ontology: OntologyRegistry,
  findings: BreakingFinding[],
): void {
  const entityName = change.name;
  const descriptor = ontology.describe(entityName);
  if (!descriptor) return; // entity not in current model → nothing existing to break

  // Fields surviving in the proposal (delete change may omit a `definition`,
  // meaning the whole entity is removed → every existing field is removed).
  const survivingFields = extractFieldNames(change);
  const removedFields = Object.keys(descriptor.fields).filter((f) => !survivingFields.has(f));

  for (const fieldName of removedFields) {
    for (const ref of findFieldReferences(entityName, fieldName, ontology)) {
      findings.push({
        code: "BREAKING_FIELD_DELETE",
        message: `Deleting field "${fieldName}" on entity "${entityName}" breaks ${ref}`,
        target: entityName,
        field: fieldName,
      });
    }
  }
}

/**
 * Use the OntologyRegistry impact graph: if anything depends on the element
 * being deleted, the deletion is a breaking reference.
 *
 * KNOWN LIMITATION (conservative under-reporting): the impact DAG does not yet
 * model edges for `StateDefinition.transitions[].action` or for an entity state
 * field's `machine`. So deleting an action used ONLY as a state transition, or a
 * state machine attached to an entity, may not surface a dependent here. This is
 * tracked as a follow-up (enhance the ontology DAG); Phase 3 deliberately
 * under-reports rather than false-positive-blocks.
 */
function detectElementDeleteImpact(
  name: string,
  type: MetaModelElementType,
  ontology: OntologyRegistry,
  findings: BreakingFinding[],
): void {
  const layers = ontology.impactAnalysis({ type, name });
  // layers[0] = [root]; layers[1+] = dependents. No dependents → not breaking.
  const dependents = layers.slice(1).flat();
  for (const dep of dependents) {
    findings.push({
      code: "BREAKING_ELEMENT_DELETE",
      message: `Deleting ${type} "${name}" breaks ${dep.type} "${dep.name}" which depends on it`,
      target: name,
    });
  }
}

// ── Update narrowing detection ───────────────────────────

/**
 * Flag an entity `update` change that narrows an existing field: type change,
 * dropping a previously-required field's default, or removing an enum value.
 */
function detectUpdateNarrowing(
  change: ProposalChange,
  ontology: OntologyRegistry,
  findings: BreakingFinding[],
): void {
  if (change.target !== "entity") return;
  const newFields = extractFields(change);
  if (!newFields) return;

  const descriptor = ontology.describe(change.name);
  if (!descriptor) return; // creating a new entity via update → no prior to narrow

  for (const [fieldName, newField] of Object.entries(newFields)) {
    const oldField = descriptor.fields[fieldName];
    if (!oldField) continue; // newly-added field → not a narrowing

    // (1) Type change — major per Spec 09 §3.4.
    if (oldField.type !== newField.type) {
      findings.push({
        code: "BREAKING_FIELD_TYPE_CHANGE",
        message: `Changing field "${fieldName}" on entity "${change.name}" from type "${oldField.type}" to "${newField.type}" is a breaking change`,
        target: change.name,
        field: fieldName,
      });
      continue; // a type change subsumes default/enum narrowing reporting
    }

    // (2) A still-required field that loses its default. If the proposal also
    // makes the field optional (required: false), dropping the now-unneeded
    // default is a loosening change, not breaking — so require newField.required.
    if (
      oldField.required &&
      newField.required &&
      oldField.default !== undefined &&
      newField.default === undefined
    ) {
      findings.push({
        code: "BREAKING_REQUIRED_DEFAULT_DROP",
        message: `Removing the default of required field "${fieldName}" on entity "${change.name}" is a breaking change`,
        target: change.name,
        field: fieldName,
      });
    }

    // (3) Removing an enum value narrows the accepted set.
    if (oldField.type === "enum" && newField.type === "enum") {
      const removed = removedEnumValues(oldField, newField);
      if (removed.length > 0) {
        findings.push({
          code: "BREAKING_ENUM_VALUE_REMOVED",
          message: `Removing enum value(s) [${removed.join(", ")}] from field "${fieldName}" on entity "${change.name}" is a breaking change`,
          target: change.name,
          field: fieldName,
        });
      }
    }
  }
}

// ── Field-reference scan ─────────────────────────────────

/**
 * Find which definitions on `entityName` reference `fieldName`. Returns
 * human-readable reference descriptions (one per referencing definition).
 */
function findFieldReferences(
  entityName: string,
  fieldName: string,
  ontology: OntologyRegistry,
): string[] {
  const refs: string[] = [];
  const descriptor = ontology.describe(entityName);
  if (!descriptor) return refs;

  // Views: a ViewFieldConfig referencing the field. `fields` is typed required,
  // but guard with optional chaining against malformed runtime view definitions.
  for (const view of descriptor.views) {
    if (view.fields?.some((vf) => vf.field === fieldName)) {
      refs.push(`view "${view.name}"`);
    }
    if (view.defaultSort?.field === fieldName) {
      refs.push(`view "${view.name}" (default sort)`);
    }
  }

  // Rules: fieldChange trigger or a condition reading the field.
  for (const rule of descriptor.rules) {
    if (ruleReferencesField(rule, entityName, fieldName)) {
      refs.push(`rule "${rule.name}"`);
    }
  }

  // Relations: many_to_many junction properties referencing the field name.
  for (const rel of descriptor.relations) {
    // RelationDescriptor does not surface junction properties; relation
    // navigation names are not field names, so only a property collision could
    // break. The descriptor lacks that detail → skip (no false positives).
    void rel;
  }

  return refs;
}

/** Does a rule reference `entityName.fieldName` via its trigger or condition? */
function ruleReferencesField(rule: RuleDefinition, entityName: string, fieldName: string): boolean {
  // Guard against malformed/incomplete rule definitions: `in` throws on a
  // non-object trigger, so verify the shape before probing it.
  const trigger = rule?.trigger;
  if (trigger && typeof trigger === "object") {
    if ("fieldChange" in trigger) {
      if (trigger.fieldChange.entity === entityName && trigger.fieldChange.field === fieldName) {
        return true;
      }
    }
    // A stateChange trigger references the entity's state field implicitly, not
    // a named field, so it is intentionally not matched here.
  }

  // Declarative conditions reference fields by name. Code conditions are opaque.
  const condition = rule?.condition;
  if (condition && typeof condition !== "function") {
    return declarativeConditionUsesField(condition, fieldName);
  }
  return false;
}

/** Recursively check whether a declarative condition reads `fieldName`. */
function declarativeConditionUsesField(condition: unknown, fieldName: string): boolean {
  if (!condition || typeof condition !== "object") return false;
  const c = condition as {
    field?: unknown;
    operator?: unknown;
    conditions?: unknown;
    condition?: unknown;
  };
  if (typeof c.field === "string" && c.field === fieldName) return true;
  if (Array.isArray(c.conditions)) {
    return c.conditions.some((sub) => declarativeConditionUsesField(sub, fieldName));
  }
  if (c.condition) {
    return declarativeConditionUsesField(c.condition, fieldName);
  }
  return false;
}

// ── Field-shape helpers ──────────────────────────────────

/** Extract the `fields` record from an entity change definition, if present. */
function extractFields(change: ProposalChange): Record<string, FieldDefinition> | undefined {
  const def = change.definition as { fields?: Record<string, FieldDefinition> } | undefined;
  if (!def || typeof def !== "object" || !def.fields) return undefined;
  return def.fields;
}

/** Names of fields surviving in a change's definition (empty if none). */
function extractFieldNames(change: ProposalChange): Set<string> {
  const fields = extractFields(change);
  return new Set(fields ? Object.keys(fields) : []);
}

/** Enum values present in `oldField` but missing from `newField`. */
function removedEnumValues(oldField: FieldDefinition, newField: FieldDefinition): string[] {
  const oldOptions = enumOptionValues(oldField);
  const newOptions = new Set(enumOptionValues(newField));
  return oldOptions.filter((v) => !newOptions.has(v));
}

/** Extract the set of enum option values from an enum field definition. */
function enumOptionValues(field: FieldDefinition): string[] {
  const enumField = field as Partial<EnumField>;
  if (!Array.isArray(enumField.options)) return [];
  return enumField.options
    .map((o) => (o && typeof o === "object" ? o.value : undefined))
    .filter((v): v is string => typeof v === "string");
}
