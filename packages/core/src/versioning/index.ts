/**
 * Versioning module — public exports
 *
 * Release compatibility, schema migration, and version tracking
 * per spec 38 (release_compatibility).
 */

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
export type { MigrationResult, MigrationTransform, SchemaMigration } from "./migration";
export { applyMigration, MigrationRegistry, validateUpgrade } from "./migration";
export type {
  CompatibilityCheckResult,
  VersionEntry,
  VersionedEntityType,
  VersionQuery,
} from "./version-registry";
export { createVersionRegistry, VersionRegistry } from "./version-registry";
