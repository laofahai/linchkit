/**
 * Migration pipeline barrel.
 *
 * Re-exports the Proposal Migration types, detector, planner, and validator
 * defined in Spec 62. Pure, runtime-agnostic — no Drizzle or live DB calls.
 */

export {
  buildMigrationSnapshot,
  type DetectMigrationChangesOptions,
  detectMigrationChanges,
  isTypeWidening,
} from "./proposal-migration-detector";
export { planMigration } from "./proposal-migration-planner";
export type {
  AddColumnChange,
  AddForeignKeyChange,
  AlterColumnTypeChange,
  CreateTableChange,
  DropColumnChange,
  DropForeignKeyChange,
  DropTableChange,
  EntitySnapshot,
  MigrationChange,
  MigrationClassification,
  MigrationForeignKey,
  MigrationIssueSeverity,
  MigrationPhase,
  MigrationPlan,
  MigrationSnapshot,
  MigrationValidationIssue,
  MigrationValidationResult,
  RenameColumnChange,
  ReversibilityTag,
} from "./proposal-migration-types";

export { validateMigrationPlan } from "./proposal-migration-validator";
