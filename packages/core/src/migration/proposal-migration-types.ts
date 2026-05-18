/**
 * Proposal Migration — shared types (Spec 62)
 *
 * Pure type-only module used by the detector, planner, and validator.
 * Runtime-agnostic: no Drizzle runtime or live DB dependency. The pipeline
 * operates on entity definition snapshots and emits plain SQL strings.
 *
 * The vocabulary intentionally narrows the broader change set in Spec 62 §3
 * to the column-level and table-level DDL operations a Proposal can produce.
 * Index / data-transform changes belong to a future iteration (Spec 62 §9
 * Phase 3) and are not modelled here.
 */
import type { FieldDefinition } from "../types/entity";

// ── Entity snapshots ──────────────────────────────────────────

/**
 * Lightweight foreign-key descriptor used in entity snapshots.
 * Decoupled from the OntologyRegistry so callers can build snapshots from
 * plain JSON (e.g. a Proposal payload) without pulling in runtime state.
 */
export interface MigrationForeignKey {
  /** Column on the owning entity that holds the reference */
  field: string;
  /** Target entity name */
  toEntity: string;
  /** Target field on the referenced entity (defaults to "id" if omitted) */
  toField?: string;
  /** Stable identifier for the constraint; derived from field if omitted */
  name?: string;
}

/**
 * Snapshot of a single entity used by the detector. Includes only what the
 * migration pipeline needs — name, fields, and FK relationships. Other
 * EntityDefinition metadata (UI, semantics, exposure) is irrelevant for DDL.
 */
export interface EntitySnapshot {
  name: string;
  fields: Record<string, FieldDefinition>;
  foreignKeys?: MigrationForeignKey[];
}

/**
 * A snapshot of multiple entities, keyed by name. Used as the `before`/`after`
 * inputs to {@link detectMigrationChanges}.
 */
export interface MigrationSnapshot {
  entities: Record<string, EntitySnapshot>;
}

// ── Change kinds ──────────────────────────────────────────────

/** Discriminated union of all migration change kinds supported by the pipeline. */
export type MigrationChange =
  | AddColumnChange
  | DropColumnChange
  | AlterColumnTypeChange
  | AddForeignKeyChange
  | DropForeignKeyChange
  | RenameColumnChange
  | CreateTableChange
  | DropTableChange;

export interface AddColumnChange {
  kind: "add_column";
  entity: string;
  field: string;
  definition: FieldDefinition;
}

export interface DropColumnChange {
  kind: "drop_column";
  entity: string;
  field: string;
  /** The dropped field's prior definition, captured for rollback */
  previousDefinition: FieldDefinition;
}

export interface AlterColumnTypeChange {
  kind: "alter_column_type";
  entity: string;
  field: string;
  fromType: FieldDefinition["type"];
  toType: FieldDefinition["type"];
}

export interface AddForeignKeyChange {
  kind: "add_foreign_key";
  entity: string;
  foreignKey: MigrationForeignKey;
}

export interface DropForeignKeyChange {
  kind: "drop_foreign_key";
  entity: string;
  foreignKey: MigrationForeignKey;
}

export interface RenameColumnChange {
  kind: "rename_column";
  entity: string;
  fromField: string;
  toField: string;
  /** Field definition (used to preserve type on rollback) */
  definition: FieldDefinition;
}

export interface CreateTableChange {
  kind: "create_table";
  entity: string;
  definition: EntitySnapshot;
}

export interface DropTableChange {
  kind: "drop_table";
  entity: string;
  /** Previous definition captured so rollback can rebuild the table */
  previousDefinition: EntitySnapshot;
}

// ── Classification ────────────────────────────────────────────

/**
 * Migration plan classification, ordered from least to most disruptive:
 *
 * - `safe`: purely additive, no locks, fully reversible (e.g. add nullable column)
 * - `expand`: additive but introduces structures the old code ignores; reversible
 *   (e.g. add FK constraint, add new table)
 * - `contract`: removes structures the new code no longer reads; data loss possible
 *   but contained (e.g. drop column, drop FK)
 * - `breaking`: irreversible or risks data loss (e.g. lossy type narrowing)
 */
export type MigrationClassification = "safe" | "expand" | "contract" | "breaking";

// ── SQL phases ────────────────────────────────────────────────

/**
 * A single named SQL phase. Matches the expand → migrate → contract pattern
 * from Spec 62 §6 but is generic enough to cover single-phase plans too.
 */
export interface MigrationPhase {
  name: "expand" | "migrate" | "contract";
  statements: string[];
}

// ── Migration plan ────────────────────────────────────────────

/**
 * The full plan: forward steps, rollback steps, and a classification.
 * Forward statements are split into phases; rollback is a flat list since
 * rollback always runs as a single contract phase from the operator's POV.
 */
export interface MigrationPlan {
  /** All changes the plan covers (in original detection order) */
  changes: MigrationChange[];
  /** Overall classification — the most disruptive change wins */
  classification: MigrationClassification;
  /** Forward steps, broken into expand / migrate / contract phases */
  forward: MigrationPhase[];
  /** Reverse-order rollback statements (best-effort for destructive changes) */
  rollback: string[];
  /** Human-readable summary of the plan */
  summary: string;
}

// ── Validation ────────────────────────────────────────────────

/** Severity of a validation issue, mirroring Spec 09's compatibility result. */
export type MigrationIssueSeverity = "error" | "warning" | "info";

/** Whether a change is reversible at the SQL level. */
export type ReversibilityTag = "reversible" | "partial" | "irreversible";

export interface MigrationValidationIssue {
  rule: string;
  severity: MigrationIssueSeverity;
  change: MigrationChange;
  reason: string;
  reversibility: ReversibilityTag;
}

export interface MigrationValidationResult {
  /** True when there are no `error`-severity issues */
  valid: boolean;
  /** Whether any change in the plan is destructive */
  destructive: boolean;
  /** Worst-case reversibility across all changes */
  reversibility: ReversibilityTag;
  /**
   * Placeholder for the dry-run data-loss simulation described in Spec 62 §5.3.
   * The runtime-agnostic validator cannot query a live DB, so this stays a
   * flag indicating whether a simulation _should_ run before approval.
   */
  dataLossSimulationRequired: boolean;
  issues: MigrationValidationIssue[];
}
