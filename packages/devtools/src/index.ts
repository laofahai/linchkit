/**
 * @linchkit/devtools — Testing tools + development debugging + documentation + methodology + governance
 *
 * testRule / testStateMachine / validateCapability / getAvailableTransitions
 * + documentation generators, methodology checks, governance tools
 */

export const VERSION = "0.0.1";

// === AI Evaluation Framework (spec 69) ===
export {
  type BaselineDiff,
  type BaselineFile,
  type BaselineFixtureEntry,
  type BaselineLayoutOptions,
  canonicalPath,
  compareToBaseline,
  createIntentScenario,
  createMatcherRegistry,
  createScenarioRegistry,
  DEFAULT_BASELINES_DIR,
  datedArchivePath,
  type EvalFixture,
  estimateCost,
  hashFixture,
  type InlineCatalogAction,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
  type IntentScenarioAdapter,
  type IntentScenarioDeps,
  intentMatchers,
  type LoadBaselineOptions,
  loadCanonicalBaseline,
  loadFixtures,
  type MarkdownReportOptions,
  type MatcherFn,
  type MatcherInvocation,
  type MatcherRegistry,
  type MatcherResult,
  type OntologyRegistryLike,
  RegressionError,
  RUNNER_VERSION,
  type RunDeps,
  type RunOptions,
  type RunReport,
  registerIntentMatchers,
  renderJsonReport,
  renderMarkdownReport,
  reportToBaselineFile,
  runEval,
  type ScenarioAdapter,
  type ScenarioRegistry,
  type WriteBaselineOptions,
  writeCanonicalBaseline,
} from "./ai-eval";

// === Documentation: API doc generation, Markdown, OpenAPI, Capability Spec, Search ===
export {
  type ActionDoc,
  type ApiDocGeneratorOptions,
  actionToDoc,
  type CapabilityActionDoc,
  type CapabilityEntityDoc,
  type CapabilityRelationDoc,
  type CapabilityRuleDoc,
  type CapabilitySpecDoc,
  type CapabilityStateMachineDoc,
  type CapabilityViewDoc,
  createDocSearchIndex,
  DocSearchIndex,
  type DocSearchOptions,
  type DocSearchResult,
  type EntityDoc,
  entityToDoc,
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
  renderEntityDoc,
  renderSystemDoc,
  type SystemDoc,
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
  validateEntityDoc,
  /** @deprecated Use validateEntityDoc instead */
  validateSchemaDoc,
} from "./governance";
// === Methodology: code quality, project structure, convention checking ===
export {
  type ActionInfo,
  type CommitInfo,
  checkActionDefinitions,
  checkCommitMessages,
  checkEntityDefinitions,
  checkFileNaming,
  checkImportPatterns,
  type DirectoryEntry,
  type EntityInfo,
  type ExportBoundaryConfig,
  type FileContent,
  type QualityIssue,
  type QualityReport,
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
