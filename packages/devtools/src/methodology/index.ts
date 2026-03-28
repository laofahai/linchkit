/**
 * Methodology utilities — Code quality, project structure, and convention checking.
 *
 * Programmatic enforcement of LinchKit development methodology (spec 29).
 * Used by CLI tooling, CI pipelines, and AI agents to validate conventions.
 */

export {
  checkImportPatterns,
  type ExportBoundaryConfig,
  type FileContent,
  type QualityIssue,
  type QualityReport,
  type Severity,
  validateExportPatterns,
  validateNamingConventions,
} from "./code-quality";
export {
  type ActionInfo,
  type CommitInfo,
  checkActionDefinitions,
  checkCommitMessages,
  checkSchemaDefinitions,
  type SchemaInfo,
} from "./convention-checker";
export {
  checkFileNaming,
  type DirectoryEntry,
  type StructureExpectation,
  validateCapabilityStructure,
  validateProjectStructure,
} from "./project-structure";
