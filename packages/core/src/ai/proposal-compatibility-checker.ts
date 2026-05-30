/**
 * AI Proposal Compatibility Checker (Phase 3)
 *
 * Detects breaking changes in a proposal against the currently registered
 * entity registry. Implements Spec 09 §4.5 (Phase 3: Compatibility Check).
 *
 * Breaking-change rules implemented:
 *  1. Drop a field that still has live FK references.
 *  2. Change a field type to an incompatible primitive type.
 *  3. Drop or rename an Entity that has FK references from other entities.
 *  4. Tighten a constraint (nullable → not-null, enum narrowing).
 *
 * The checker is intentionally **pure** — it never touches the live registry.
 * The caller passes in a `CompatibilityRegistrySnapshot` representing current
 * state; the checker returns a structured `CompatibilityResult`.
 */

import type { EntityDefinition, EnumField, FieldDefinition } from "../types/entity";
import type {
  CompatibilityChange,
  CompatibilityIssue,
  CompatibilityRegistrySnapshot,
  CompatibilityResult,
  EntityDeleteChange,
  EntityReference,
  EntityRenameChange,
  EnumOptionsChange,
  FieldConstraintChange,
  FieldDropChange,
  FieldTypeChange,
} from "./proposal-compatibility-types";

// Re-export types so consumers can import them from this module too
export type * from "./proposal-compatibility-types";

// ── Type compatibility matrix ────────────────────────────────

/**
 * Per Spec 09 §4.5, "changing a field type to an incompatible one" is breaking.
 * We treat type changes as compatible only if the new type is a strict superset
 * of the old, or identical. All other changes are flagged as breaking.
 *
 * The matrix lists *new types* that are compatible for a given *old type*.
 */
const TYPE_UPGRADE_MATRIX: Record<FieldDefinition["type"], readonly FieldDefinition["type"][]> = {
  string: ["string", "text"], // text is wider than string
  text: ["text"],
  number: ["number"],
  boolean: ["boolean"],
  date: ["date", "datetime"], // datetime is wider than date
  datetime: ["datetime"],
  enum: ["enum"],
  json: ["json"],
  state: ["state"],
  computed: ["computed"],
};

function isTypeCompatible(
  oldType: FieldDefinition["type"],
  newType: FieldDefinition["type"],
): boolean {
  return TYPE_UPGRADE_MATRIX[oldType]?.includes(newType) ?? false;
}

// ── Helpers ──────────────────────────────────────────────────

function getField(
  snapshot: CompatibilityRegistrySnapshot,
  entity: string,
  field: string,
): FieldDefinition | undefined {
  return snapshot.entities[entity]?.fields[field];
}

function fieldHasReferences(
  snapshot: CompatibilityRegistrySnapshot,
  entity: string,
  field: string,
): EntityReference[] {
  const refs = snapshot.references ?? [];
  // Either we own a field that's pointed at, OR we point at someone else
  return refs.filter(
    (r) =>
      (r.toEntity === entity && (r.toField ?? "id") === field) ||
      (r.fromEntity === entity && r.fromField === field),
  );
}

function entityHasIncomingReferences(
  snapshot: CompatibilityRegistrySnapshot,
  entity: string,
): EntityReference[] {
  const refs = snapshot.references ?? [];
  return refs.filter((r) => r.toEntity === entity);
}

// ── Per-change checkers ──────────────────────────────────────

function checkFieldDrop(
  change: FieldDropChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const refs = fieldHasReferences(snapshot, change.entity, change.field);
  if (refs.length > 0) {
    const refDesc = refs
      .map((r) => `${r.fromEntity}.${r.fromField} → ${r.toEntity}.${r.toField ?? "id"}`)
      .join(", ");
    return {
      rule: "drop_field_with_references",
      severity: "breaking",
      change,
      reason:
        `Field "${change.entity}.${change.field}" still has live FK references and ` +
        `cannot be dropped (references: ${refDesc})`,
    };
  }
  // Always warn on field drop — even without references it's a data loss event
  return undefined;
}

function checkFieldTypeChange(
  change: FieldTypeChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const current = getField(snapshot, change.entity, change.field);
  if (!current) {
    return undefined;
  }
  if (current.type === change.newType) {
    return undefined;
  }
  if (!isTypeCompatible(current.type, change.newType)) {
    return {
      rule: "incompatible_field_type_change",
      severity: "breaking",
      change,
      reason:
        `Cannot change field "${change.entity}.${change.field}" from "${current.type}" ` +
        `to "${change.newType}" — types are not compatible`,
    };
  }
  return undefined;
}

function checkEntityDelete(
  change: EntityDeleteChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const refs = entityHasIncomingReferences(snapshot, change.entity);
  if (refs.length > 0) {
    const refDesc = refs.map((r) => `${r.fromEntity}.${r.fromField}`).join(", ");
    return {
      rule: "delete_entity_with_references",
      severity: "breaking",
      change,
      reason:
        `Entity "${change.entity}" cannot be deleted — it has incoming FK references ` +
        `from: ${refDesc}`,
    };
  }
  return undefined;
}

function checkEntityRename(
  change: EntityRenameChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const refs = entityHasIncomingReferences(snapshot, change.entity);
  if (refs.length > 0) {
    const refDesc = refs.map((r) => `${r.fromEntity}.${r.fromField}`).join(", ");
    return {
      rule: "rename_entity_with_references",
      severity: "breaking",
      change,
      reason:
        `Entity "${change.entity}" cannot be renamed to "${change.newName}" — ` +
        `it has incoming FK references from: ${refDesc}`,
    };
  }
  return undefined;
}

function checkConstraintTightening(
  change: FieldConstraintChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const current = getField(snapshot, change.entity, change.field);
  if (!current) {
    return undefined;
  }
  const { patch } = change;

  // nullable → not-null
  if (patch.required === true && current.required !== true) {
    return {
      rule: "tighten_constraint_nullable_to_required",
      severity: "breaking",
      change,
      reason:
        `Tightening "${change.entity}.${change.field}" from nullable to required is ` +
        `breaking — existing rows with null values will violate the new constraint`,
    };
  }

  // adding unique constraint
  if (patch.unique === true && current.unique !== true) {
    return {
      rule: "tighten_constraint_add_unique",
      severity: "breaking",
      change,
      reason:
        `Adding a unique constraint to "${change.entity}.${change.field}" is breaking — ` +
        `existing duplicate values will violate the new constraint`,
    };
  }

  // narrowing min: raising the floor OR introducing one where none existed.
  // Adding `min` to a previously-unconstrained field rejects rows that were
  // valid before, so it is just as breaking as raising an existing floor.
  if (typeof patch.min === "number") {
    if (current.min === undefined) {
      return {
        rule: "tighten_constraint_narrow_min",
        severity: "breaking",
        change,
        reason:
          `Adding a min of ${patch.min} to "${change.entity}.${change.field}" is breaking — ` +
          `existing values below ${patch.min} will violate the new constraint`,
      };
    }
    if (typeof current.min === "number" && patch.min > current.min) {
      return {
        rule: "tighten_constraint_narrow_min",
        severity: "breaking",
        change,
        reason:
          `Raising min from ${current.min} to ${patch.min} on "${change.entity}.${change.field}" ` +
          `is breaking — existing values below ${patch.min} will violate the new constraint`,
      };
    }
  }

  // narrowing max: lowering the ceiling OR introducing one where none existed.
  // Adding `max` to a previously-unconstrained field rejects rows that were
  // valid before, so it is just as breaking as lowering an existing ceiling.
  if (typeof patch.max === "number") {
    if (current.max === undefined) {
      return {
        rule: "tighten_constraint_narrow_max",
        severity: "breaking",
        change,
        reason:
          `Adding a max of ${patch.max} to "${change.entity}.${change.field}" is breaking — ` +
          `existing values above ${patch.max} will violate the new constraint`,
      };
    }
    if (typeof current.max === "number" && patch.max < current.max) {
      return {
        rule: "tighten_constraint_narrow_max",
        severity: "breaking",
        change,
        reason:
          `Lowering max from ${current.max} to ${patch.max} on "${change.entity}.${change.field}" ` +
          `is breaking — existing values above ${patch.max} will violate the new constraint`,
      };
    }
  }

  return undefined;
}

function checkEnumOptionsChange(
  change: EnumOptionsChange,
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityIssue | undefined {
  const current = getField(snapshot, change.entity, change.field);
  if (current?.type !== "enum") {
    return undefined;
  }
  const oldOptions = new Set((current as EnumField).options.map((o) => o.value));
  const newOptions = new Set(change.newOptions);
  const removed: string[] = [];
  for (const opt of oldOptions) {
    if (!newOptions.has(opt)) {
      removed.push(opt);
    }
  }
  if (removed.length > 0) {
    return {
      rule: "tighten_constraint_narrow_enum",
      severity: "breaking",
      change,
      reason:
        `Narrowing enum "${change.entity}.${change.field}" by removing options ` +
        `[${removed.join(", ")}] is breaking — existing rows with these values become invalid`,
    };
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Run a compatibility check over the given changes against a registry snapshot.
 *
 * @param changes - The proposed changes (semantically rich, field-level)
 * @param snapshot - Read-only snapshot of the current registry state
 * @returns Structured compatibility result with breaking issues / warnings
 */
export function compatibilityCheck(
  changes: CompatibilityChange[],
  snapshot: CompatibilityRegistrySnapshot,
): CompatibilityResult {
  const breaking: CompatibilityIssue[] = [];
  const warnings: CompatibilityIssue[] = [];
  const info: CompatibilityIssue[] = [];

  for (const change of changes) {
    let issue: CompatibilityIssue | undefined;

    switch (change.kind) {
      case "field_drop":
        issue = checkFieldDrop(change, snapshot);
        if (!issue) {
          // Data-loss warning even without FK references
          warnings.push({
            rule: "drop_field_data_loss",
            severity: "warning",
            change,
            reason:
              `Dropping field "${change.entity}.${change.field}" will discard ` +
              `existing data — prefer mark-deprecated then remove in next major`,
          });
        }
        break;

      case "field_type_change":
        issue = checkFieldTypeChange(change, snapshot);
        break;

      case "entity_delete":
        issue = checkEntityDelete(change, snapshot);
        if (!issue) {
          warnings.push({
            rule: "delete_entity_data_loss",
            severity: "warning",
            change,
            reason:
              `Deleting entity "${change.entity}" will discard all stored records — ` +
              `prefer mark-deprecated then remove in next major`,
          });
        }
        break;

      case "entity_rename":
        issue = checkEntityRename(change, snapshot);
        break;

      case "field_constraint_change":
        issue = checkConstraintTightening(change, snapshot);
        break;

      case "enum_options_change":
        issue = checkEnumOptionsChange(change, snapshot);
        break;

      case "entity_create":
        // Adding a new entity is always backward-compatible
        info.push({
          rule: "entity_added",
          severity: "info",
          change,
          reason: `New entity "${change.entity}" added`,
        });
        break;

      case "field_add":
        // Adding a required field without a default is breaking against existing rows
        if (change.definition.required && change.definition.default === undefined) {
          breaking.push({
            rule: "add_required_field_without_default",
            severity: "breaking",
            change,
            reason:
              `Adding required field "${change.entity}.${change.field}" without a default ` +
              `is breaking — existing rows have no value for the new column`,
          });
        } else {
          info.push({
            rule: "field_added",
            severity: "info",
            change,
            reason: `New field "${change.entity}.${change.field}" added`,
          });
        }
        break;

      default: {
        // Exhaustiveness check — TS will error if a new kind is added
        const _exhaustive: never = change;
        void _exhaustive;
      }
    }

    if (issue) {
      if (issue.severity === "breaking") {
        breaking.push(issue);
      } else if (issue.severity === "warning") {
        warnings.push(issue);
      } else {
        info.push(issue);
      }
    }
  }

  // Cross-change consistency: if the same field is dropped and then re-added
  // with a new type, surface that as an info note rather than a clean drop.
  // Two passes (O(N)) keyed by "entity.field" instead of O(N²) nested loops:
  //   pass 1 → index all field_add changes by their target key
  //   pass 2 → for every field_drop, look the matching add up in the index
  const addIndex = new Map<string, CompatibilityChange & { kind: "field_add" }>();
  for (const change of changes) {
    if (change.kind === "field_add") {
      addIndex.set(`${change.entity}.${change.field}`, change);
    }
  }
  for (const change of changes) {
    if (change.kind !== "field_drop") continue;
    const match = addIndex.get(`${change.entity}.${change.field}`);
    if (match) {
      info.push({
        rule: "field_drop_and_readd",
        severity: "info",
        change: match,
        reason:
          `Field "${change.entity}.${change.field}" is dropped and re-added — ` +
          `treat as a destructive replacement`,
      });
    }
  }

  return {
    compatible: breaking.length === 0,
    breaking,
    warnings,
    info,
  };
}

/**
 * Build a snapshot from a flat list of entity definitions and references.
 * Convenience helper for callers that hold their state as arrays.
 */
export function buildCompatibilitySnapshot(
  entities: EntityDefinition[],
  references: EntityReference[] = [],
): CompatibilityRegistrySnapshot {
  const map: Record<string, EntityDefinition> = {};
  for (const e of entities) {
    map[e.name] = e;
  }
  return { entities: map, references };
}
