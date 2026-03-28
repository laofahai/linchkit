/**
 * Migration Capability
 *
 * Provides version compatibility checking, schema migration transforms,
 * version registry, Drizzle DB migration runner, and legacy data import tools.
 */

// ── Version compatibility (spec 38) ────────────────────────
export type {
  BreakingChange,
  ReleaseCompatibilityResult,
  ReleaseType,
  RollbackMode,
  SemVer,
  TenantOverrideImpact,
} from "./compatibility";
export {
  analyzeCompatibility,
  classifyRelease,
  compareSemVer,
  formatSemVer,
  getBreakingChanges,
  isCompatible,
  parseSemVer,
} from "./compatibility";
// ── Legacy data import utilities ───────────────────────────
export {
  CSVImportSource,
  type CSVImportSourceOptions,
  DataImporter,
  type DataImporterOptions,
  type ErrorMode,
  type ImportProgress,
  type ImportRecordError,
  type ImportResult,
  type ImportSource,
  JSONImportSource,
  type JSONImportSourceOptions,
} from "./data-importer";
// ── Drizzle DB migration runner ────────────────────────────
export { type MigrateOptions, runMigrations } from "./db-migrate";
export {
  type MigrationPlan,
  type MigrationResult,
  MigrationResumeTracker,
  MigrationRunner,
  type MigrationRunnerOptions,
} from "./migration-runner";
export {
  type BuiltInTransform,
  type FieldMapping,
  type MappedRecord,
  type MappingValidationResult,
  SchemaMapper,
} from "./schema-mapper";
// ── Schema migration transforms ────────────────────────────
export type {
  MigrationResult as SchemaMigrationResult,
  MigrationTransform,
  SchemaMigration,
} from "./schema-migration";
export { applyMigration, MigrationRegistry, validateUpgrade } from "./schema-migration";
// ── Version registry ───────────────────────────────────────
export type {
  CompatibilityCheckResult,
  VersionEntry,
  VersionedEntityType,
  VersionQuery,
} from "./version-registry";
export { createVersionRegistry, VersionRegistry } from "./version-registry";
