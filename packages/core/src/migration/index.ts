/**
 * Legacy Migration Utilities
 *
 * Tools for importing data from external systems into LinchKit schemas.
 * Includes pluggable source adapters, field mapping with transforms,
 * and an orchestration runner with dry-run and resume support.
 */

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
