/**
 * Migration — release compatibility checker (Spec 38 §9). Browser-safe.
 */

export type {
  MigrationAnalysis,
  ReleaseCompatibilityResult,
  ReleaseType,
  RollbackMode,
  StatementAnalysis,
  TenantOverrideImpact,
} from "../../migration/release-compatibility";
export {
  aggregateReleaseType,
  analyzeFile,
  analyzeMigrationSql,
  buildResult,
  checkReleaseCompatibility,
  classifyStatement,
  splitStatements,
} from "../../migration/release-compatibility";
