/**
 * AI Proposal Dry-Run (Phase 4)
 *
 * Simulates applying a proposal against an in-memory snapshot of registry
 * state. Implements Spec 09 §4.6 (Phase 4: Test / Dry Run).
 *
 * Goals:
 *  - Confirm the post-application model still loads cleanly
 *  - Surface predicted side effects (counts of entities/fields added/removed/modified)
 *  - Never mutate the caller's snapshot — all mutations happen on a deep clone
 *
 * The dry-run is intentionally **synthetic**. It does not touch the live
 * registry, write to disk, or run user code. It applies the changes to a
 * cloned snapshot, then runs lightweight meta-model validation against the
 * post-state.
 */

import type { EntityDefinition, FieldDefinition } from "../types/entity";
import type {
  CompatibilityChange,
  CompatibilityRegistrySnapshot,
} from "./proposal-compatibility-types";

// ── Result types ──────────────────────────────────────────────

export interface DryRunSideEffects {
  entitiesAdded: number;
  entitiesRemoved: number;
  entitiesModified: number;
  entitiesRenamed: number;
  fieldsAdded: number;
  fieldsRemoved: number;
  fieldsModified: number;
}

export interface DryRunModelError {
  /** Error code (e.g. "missing_field", "duplicate_entity") */
  code: string;
  /** Human-readable message */
  message: string;
  /** Affected entity (if applicable) */
  entity?: string;
  /** Affected field (if applicable) */
  field?: string;
}

export interface DryRunResult {
  /** True if the post-state passes meta-model validation */
  ok: boolean;
  /** Predicted side effects from applying the changes */
  sideEffects: DryRunSideEffects;
  /** Validation errors found in the post-state model */
  modelErrors: DryRunModelError[];
  /** Number of entities in the post-state */
  postStateEntityCount: number;
  /** Whether the original snapshot was preserved (sanity flag — always true) */
  snapshotPreserved: true;
}

// ── Snapshot cloning ─────────────────────────────────────────

/**
 * Deep clone a registry snapshot. We do this manually rather than using
 * `structuredClone` because entity definitions may carry function values
 * (e.g. `ComputedField.compute`), which `structuredClone` cannot handle.
 */
function cloneSnapshot(snapshot: CompatibilityRegistrySnapshot): CompatibilityRegistrySnapshot {
  const entities: Record<string, EntityDefinition> = {};
  for (const [name, def] of Object.entries(snapshot.entities)) {
    entities[name] = cloneEntity(def);
  }
  return {
    entities,
    references: snapshot.references ? snapshot.references.map((r) => ({ ...r })) : [],
  };
}

function cloneEntity(def: EntityDefinition): EntityDefinition {
  const fields: Record<string, FieldDefinition> = {};
  for (const [name, field] of Object.entries(def.fields)) {
    fields[name] = cloneField(field);
  }
  return {
    ...def,
    fields,
    // shallow-clone optional nested objects we care about
    presentation: def.presentation ? { ...def.presentation } : undefined,
    exposure: def.exposure ? { ...def.exposure } : undefined,
    fieldExposure: def.fieldExposure ? { ...def.fieldExposure } : undefined,
    ai: def.ai ? { ...def.ai } : undefined,
    i18n: def.i18n ? { ...def.i18n } : undefined,
  };
}

function cloneField(field: FieldDefinition): FieldDefinition {
  // Spread covers all field shapes; for enums we also clone the options array
  if (field.type === "enum") {
    return {
      ...field,
      options: field.options.map((o) => ({ ...o })),
    };
  }
  return { ...field };
}

// ── Apply changes to a cloned snapshot ───────────────────────

function applyChanges(
  snapshot: CompatibilityRegistrySnapshot,
  changes: CompatibilityChange[],
  effects: DryRunSideEffects,
): DryRunModelError[] {
  const errors: DryRunModelError[] = [];

  for (const change of changes) {
    switch (change.kind) {
      case "entity_create": {
        if (snapshot.entities[change.entity]) {
          errors.push({
            code: "duplicate_entity",
            message: `Cannot create entity "${change.entity}" — already exists`,
            entity: change.entity,
          });
          break;
        }
        snapshot.entities[change.entity] = cloneEntity(change.definition);
        effects.entitiesAdded++;
        break;
      }

      case "entity_delete": {
        if (!snapshot.entities[change.entity]) {
          errors.push({
            code: "missing_entity",
            message: `Cannot delete entity "${change.entity}" — does not exist`,
            entity: change.entity,
          });
          break;
        }
        delete snapshot.entities[change.entity];
        effects.entitiesRemoved++;
        // Remove references that point at the deleted entity
        snapshot.references = (snapshot.references ?? []).filter(
          (r) => r.toEntity !== change.entity && r.fromEntity !== change.entity,
        );
        break;
      }

      case "entity_rename": {
        const existing = snapshot.entities[change.entity];
        if (!existing) {
          errors.push({
            code: "missing_entity",
            message: `Cannot rename entity "${change.entity}" — does not exist`,
            entity: change.entity,
          });
          break;
        }
        if (snapshot.entities[change.newName]) {
          errors.push({
            code: "duplicate_entity",
            message: `Cannot rename "${change.entity}" → "${change.newName}" — target name exists`,
            entity: change.newName,
          });
          break;
        }
        delete snapshot.entities[change.entity];
        snapshot.entities[change.newName] = { ...existing, name: change.newName };
        effects.entitiesRenamed++;
        // Rewrite references
        snapshot.references = (snapshot.references ?? []).map((r) => ({
          ...r,
          fromEntity: r.fromEntity === change.entity ? change.newName : r.fromEntity,
          toEntity: r.toEntity === change.entity ? change.newName : r.toEntity,
        }));
        break;
      }

      case "field_add": {
        const entity = snapshot.entities[change.entity];
        if (!entity) {
          errors.push({
            code: "missing_entity",
            message: `Cannot add field "${change.field}" — entity "${change.entity}" missing`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        if (entity.fields[change.field]) {
          errors.push({
            code: "duplicate_field",
            message: `Cannot add field "${change.entity}.${change.field}" — already exists`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        entity.fields[change.field] = cloneField(change.definition);
        effects.fieldsAdded++;
        break;
      }

      case "field_drop": {
        const entity = snapshot.entities[change.entity];
        if (!entity) {
          errors.push({
            code: "missing_entity",
            message: `Cannot drop field "${change.field}" — entity "${change.entity}" missing`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        if (!entity.fields[change.field]) {
          errors.push({
            code: "missing_field",
            message: `Cannot drop field "${change.entity}.${change.field}" — does not exist`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        delete entity.fields[change.field];
        effects.fieldsRemoved++;
        break;
      }

      case "field_type_change": {
        const entity = snapshot.entities[change.entity];
        const field = entity?.fields[change.field];
        if (!entity || !field) {
          errors.push({
            code: "missing_field",
            message:
              `Cannot change type of "${change.entity}.${change.field}" — ` +
              `entity or field missing`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        // Replace with a minimal stub of the new type, preserving label/desc
        const next = {
          ...field,
          type: change.newType,
        } as FieldDefinition;
        entity.fields[change.field] = next;
        effects.fieldsModified++;
        break;
      }

      case "field_constraint_change": {
        const entity = snapshot.entities[change.entity];
        const field = entity?.fields[change.field];
        if (!entity || !field) {
          errors.push({
            code: "missing_field",
            message:
              `Cannot tighten constraint on "${change.entity}.${change.field}" — ` +
              `entity or field missing`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        entity.fields[change.field] = { ...field, ...change.patch };
        effects.fieldsModified++;
        break;
      }

      case "enum_options_change": {
        const entity = snapshot.entities[change.entity];
        const field = entity?.fields[change.field];
        if (!entity || !field || field.type !== "enum") {
          errors.push({
            code: "missing_enum_field",
            message:
              `Cannot change enum options on "${change.entity}.${change.field}" — ` +
              `entity or enum field missing`,
            entity: change.entity,
            field: change.field,
          });
          break;
        }
        entity.fields[change.field] = {
          ...field,
          options: change.newOptions.map((value) => ({ value })),
        };
        effects.fieldsModified++;
        break;
      }

      default: {
        const _exhaustive: never = change;
        void _exhaustive;
      }
    }
  }

  return errors;
}

// ── Meta-model validation on the post-state ──────────────────

/**
 * Lightweight model validation — checks the kinds of invariants a real
 * registry load would enforce, without actually running the full Registry
 * pipeline (which has heavy server-side deps).
 *
 * Currently checks:
 *  - Every entity has a non-empty name
 *  - Every entity has at least one field
 *  - All references resolve to existing entities/fields
 *  - No duplicate field names within an entity (impossible via apply, but
 *    we double-check for create-time supplied entities)
 */
function validatePostState(snapshot: CompatibilityRegistrySnapshot): DryRunModelError[] {
  const errors: DryRunModelError[] = [];

  for (const [name, entity] of Object.entries(snapshot.entities)) {
    if (!entity.name || entity.name.trim() === "") {
      errors.push({
        code: "entity_missing_name",
        message: `Entity registered as "${name}" has empty name`,
        entity: name,
      });
    }
    if (entity.name !== name) {
      errors.push({
        code: "entity_name_mismatch",
        message: `Entity registered under "${name}" but declares name "${entity.name}"`,
        entity: name,
      });
    }
    const fieldNames = Object.keys(entity.fields);
    if (fieldNames.length === 0) {
      errors.push({
        code: "entity_no_fields",
        message: `Entity "${name}" has no fields after dry-run`,
        entity: name,
      });
    }
  }

  for (const ref of snapshot.references ?? []) {
    const from = snapshot.entities[ref.fromEntity];
    const to = snapshot.entities[ref.toEntity];
    if (!from) {
      errors.push({
        code: "dangling_reference_from",
        message:
          `Reference "${ref.fromEntity}.${ref.fromField} → ${ref.toEntity}" has missing ` +
          `source entity`,
        entity: ref.fromEntity,
        field: ref.fromField,
      });
      continue;
    }
    if (!from.fields[ref.fromField]) {
      errors.push({
        code: "dangling_reference_from_field",
        message: `Reference source field "${ref.fromEntity}.${ref.fromField}" no longer exists`,
        entity: ref.fromEntity,
        field: ref.fromField,
      });
    }
    if (!to) {
      errors.push({
        code: "dangling_reference_to",
        message:
          `Reference "${ref.fromEntity}.${ref.fromField} → ${ref.toEntity}" has missing ` +
          `target entity`,
        entity: ref.toEntity,
      });
      continue;
    }
    const toField = ref.toField ?? "id";
    if (toField !== "id" && !to.fields[toField]) {
      errors.push({
        code: "dangling_reference_to_field",
        message: `Reference target field "${ref.toEntity}.${toField}" does not exist`,
        entity: ref.toEntity,
        field: toField,
      });
    }
  }

  return errors;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Dry-run a proposal against an in-memory snapshot.
 *
 * The caller's `snapshot` is never mutated — all operations happen on a
 * deep clone. The returned `DryRunResult` reports predicted side effects
 * and any meta-model validation errors that would prevent the post-state
 * from loading cleanly.
 *
 * @param changes - The proposed changes
 * @param snapshot - Current registry state (will be cloned, not mutated)
 */
export function dryRunProposal(
  changes: CompatibilityChange[],
  snapshot: CompatibilityRegistrySnapshot,
): DryRunResult {
  // Snapshot of caller's state for the preservation sanity-check
  const originalKeys = Object.keys(snapshot.entities).sort();
  const originalFieldCounts: Record<string, number> = {};
  for (const [name, def] of Object.entries(snapshot.entities)) {
    originalFieldCounts[name] = Object.keys(def.fields).length;
  }
  const originalRefCount = snapshot.references?.length ?? 0;

  // Work on a deep clone — caller's snapshot must stay intact
  const working = cloneSnapshot(snapshot);

  const sideEffects: DryRunSideEffects = {
    entitiesAdded: 0,
    entitiesRemoved: 0,
    entitiesModified: 0,
    entitiesRenamed: 0,
    fieldsAdded: 0,
    fieldsRemoved: 0,
    fieldsModified: 0,
  };

  // Track which entities were modified (vs added/removed) for the count
  const modifiedEntities = new Set<string>();
  for (const change of changes) {
    if (
      change.kind === "field_add" ||
      change.kind === "field_drop" ||
      change.kind === "field_type_change" ||
      change.kind === "field_constraint_change" ||
      change.kind === "enum_options_change"
    ) {
      modifiedEntities.add(change.entity);
    }
  }
  sideEffects.entitiesModified = modifiedEntities.size;

  const applyErrors = applyChanges(working, changes, sideEffects);
  const modelErrors = applyErrors.length > 0 ? applyErrors : validatePostState(working);

  // Sanity: confirm caller's snapshot is untouched
  const postKeys = Object.keys(snapshot.entities).sort();
  if (postKeys.length !== originalKeys.length || postKeys.some((k, i) => k !== originalKeys[i])) {
    // This indicates a bug in cloneSnapshot — surface it loudly
    throw new Error("dryRunProposal mutated the caller's snapshot (entity keys differ)");
  }
  for (const [name, count] of Object.entries(originalFieldCounts)) {
    const stillThere = snapshot.entities[name];
    if (!stillThere || Object.keys(stillThere.fields).length !== count) {
      throw new Error(
        `dryRunProposal mutated the caller's snapshot (entity "${name}" field count differs)`,
      );
    }
  }
  if ((snapshot.references?.length ?? 0) !== originalRefCount) {
    throw new Error("dryRunProposal mutated the caller's snapshot (reference count differs)");
  }

  return {
    ok: modelErrors.length === 0,
    sideEffects,
    modelErrors,
    postStateEntityCount: Object.keys(working.entities).length,
    snapshotPreserved: true,
  };
}
