/**
 * @linchkit/devtools — Testing tools + development debugging + documentation + methodology + governance
 *
 * testRule / testStateMachine / validateCapability / getAvailableTransitions
 * + documentation generators, methodology checks, governance tools
 */

export const VERSION = "0.0.1";

// === Documentation: API doc generation, Markdown, OpenAPI, Capability Spec, Search ===
export {
  type ActionDoc,
  type ApiDocGeneratorOptions,
  actionToDoc,
  type CapabilityActionDoc,
  type CapabilityRelationDoc,
  type CapabilityRuleDoc,
  type CapabilitySchemaDoc,
  type CapabilitySpecDoc,
  type CapabilityStateMachineDoc,
  type CapabilityViewDoc,
  createDocSearchIndex,
  DocSearchIndex,
  type DocSearchOptions,
  type DocSearchResult,
  type FieldDoc,
  fieldToDoc,
  generateApiDoc,
  generateCapabilityDoc,
  generateOpenAPISpec,
  type MarkdownRenderOptions,
  type OpenAPIGeneratorOptions,
  type OpenAPIOperation,
  type OpenAPIPathItem,
  type OpenAPISchemaObject,
  type OpenAPISpec,
  renderActionDoc,
  renderCapabilityDoc,
  renderSchemaDoc,
  renderSystemDoc,
  type SchemaDoc,
  type SystemDoc,
  schemaToDoc,
} from "./documentation";
// === Governance: documentation validation, spec tracking, changelog ===
export {
  type ChangelogOptions,
  type ConventionalCommit,
  type DocCompleteness,
  type DocIssue,
  generateChangelog,
  generateSpecReport,
  generateVersionedChangelog,
  parseConventionalCommit,
  type SpecProgressReport,
  type SpecStatus,
  type SpecStatusValue,
  SpecTracker,
  type VersionGroup,
  validateActionDoc,
  validateCapabilityDoc as validateCapabilityDocCompleteness,
  validateSchemaDoc,
} from "./governance";
// === Methodology: code quality, project structure, convention checking ===
export {
  type ActionInfo,
  type CommitInfo,
  checkActionDefinitions,
  checkCommitMessages,
  checkFileNaming,
  checkImportPatterns,
  checkEntityDefinitions,
  type DirectoryEntry,
  type ExportBoundaryConfig,
  type FileContent,
  type QualityIssue,
  type QualityReport,
  type SchemaInfo,
  type Severity,
  type StructureExpectation,
  validateCapabilityStructure,
  validateExportPatterns,
  validateNamingConventions,
  validateProjectStructure,
} from "./methodology";
export type { TestRuleInput } from "./test-rule";
export { testRule } from "./test-rule";
export type {
  MockAIResponse,
  MockAIService,
  TestRuntime,
  TestRuntimeOptions,
} from "./test-runtime";
export { createTestActor, createTestRuntime, mockAIService } from "./test-runtime";
export type { TestTransitionInput } from "./test-state";
export { getAvailableTransitions, testStateMachine } from "./test-state";
export type { CapabilityValidationResult, ValidationIssue } from "./validate-capability";
export { validateCapability } from "./validate-capability";
