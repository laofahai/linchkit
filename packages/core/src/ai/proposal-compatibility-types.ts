/**
 * AI Proposal Compatibility — shared types (Spec 09 Phase 3)
 *
 * Pure type-only module so both the checker (`proposal-compatibility-checker.ts`)
 * and the dry-run (`proposal-dry-run.ts`) can consume the same vocabulary
 * without circular imports or oversized files.
 */

import type { EntityDefinition, FieldDefinition } from "../types/entity";

// ── Snapshot types ────────────────────────────────────────────

/**
 * A reference from one entity field to another entity. Used to detect
 * "drop field with data references" and "drop entity with FK references".
 */
export interface EntityReference {
  /** Entity that owns the referencing field */
  fromEntity: string;
  /** Field on that entity that points to the target entity */
  fromField: string;
  /** Target entity name */
  toEntity: string;
  /** Target field on the referenced entity (defaults to "id") */
  toField?: string;
}

/**
 * Snapshot of the registry state used as a baseline for compatibility checks.
 * The snapshot is immutable from the checker's perspective — it is only read.
 */
export interface CompatibilityRegistrySnapshot {
  /** Currently registered entities, keyed by entity name */
  entities: Record<string, EntityDefinition>;
  /** Cross-entity FK references */
  references?: EntityReference[];
}

// ── Change types ──────────────────────────────────────────────

/**
 * A semantically rich change description used by the compatibility checker
 * and the dry-run runner. Distinct from the security `ProposalChange` in
 * `proposal-validator.ts` — that one only carries a coarse change type +
 * target name, which is not enough to reason about field-level breakage.
 */
export type CompatibilityChange =
  | EntityCreateChange
  | EntityDeleteChange
  | EntityRenameChange
  | FieldAddChange
  | FieldDropChange
  | FieldTypeChange
  | FieldConstraintChange
  | EnumOptionsChange;

export interface EntityCreateChange {
  kind: "entity_create";
  entity: string;
  definition: EntityDefinition;
}

export interface EntityDeleteChange {
  kind: "entity_delete";
  entity: string;
}

export interface EntityRenameChange {
  kind: "entity_rename";
  entity: string;
  newName: string;
}

export interface FieldAddChange {
  kind: "field_add";
  entity: string;
  field: string;
  definition: FieldDefinition;
}

export interface FieldDropChange {
  kind: "field_drop";
  entity: string;
  field: string;
}

export interface FieldTypeChange {
  kind: "field_type_change";
  entity: string;
  field: string;
  newType: FieldDefinition["type"];
}

export interface FieldConstraintChange {
  kind: "field_constraint_change";
  entity: string;
  field: string;
  /** New constraint patch (only the fields being changed) */
  patch: {
    required?: boolean;
    unique?: boolean;
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface EnumOptionsChange {
  kind: "enum_options_change";
  entity: string;
  field: string;
  /** New set of enum option values */
  newOptions: string[];
}

// ── Result types ──────────────────────────────────────────────

export type CompatibilitySeverity = "breaking" | "warning" | "info";

export interface CompatibilityIssue {
  /** Rule identifier (stable string, suitable for grep/log) */
  rule: string;
  severity: CompatibilitySeverity;
  /** The change that triggered this issue */
  change: CompatibilityChange;
  /** Human-readable reason */
  reason: string;
}

export interface CompatibilityResult {
  /** True if no breaking-change issues were found */
  compatible: boolean;
  /** All breaking issues */
  breaking: CompatibilityIssue[];
  /** Non-breaking warnings (e.g. adding required field with default) */
  warnings: CompatibilityIssue[];
  /** Informational notes */
  info: CompatibilityIssue[];
}
