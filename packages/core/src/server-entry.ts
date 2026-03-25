/**
 * @linchkit/core/server — Server-only modules
 *
 * Runtime engines, database, Drizzle ORM, event bus, flow, observability, AI.
 * NOT safe for browser — requires Node/Bun runtime.
 *
 * Usage: import { createActionExecutor, SchemaRegistry } from "@linchkit/core/server"
 */

// === Automation engine ===

export {
  type AutomationActionExecutor,
  type AutomationEngine,
  type AutomationEngineOptions,
  type AutomationFlowStarter,
  type AutomationNotifier,
  type AutomationRegistry,
  createAutomationEngine,
  createAutomationRegistry,
  parseCronToInterval,
} from "./automation";

// === Engine: action, command, approval, state, rule, validation, permission, proposal ===

export {
  type ActionExecutor,
  type ActionExecutorOptions,
  ActionRegistry,
  createActionExecutor,
  type DataProvider,
  type DataQueryOptions,
  type ExecuteOptions,
  type ExecutionChannel,
  type PendingEvent,
  type TransactionManager,
} from "./engine/action-engine";

export {
  type ApprovalEngine,
  type ApprovalEngineOptions,
  type CreateApprovalOptions,
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "./engine/approval-engine";

export {
  type CommandContext,
  type CommandExecuteOptions,
  type CommandLayer,
  type CommandLayerOptions,
  createCommandLayer,
  ExposureError,
  type MiddlewareHandler,
  type MiddlewareRegistration,
  PipelineError,
  type SlotName,
} from "./engine/command-layer";

export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./engine/permission-engine";

export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  ProposalEngine,
} from "./engine/proposal-engine";

export {
  createProposalGenerator,
  ProposalGenerationError,
  type ProposalGeneratorDeps,
} from "./engine/proposal-generator";

export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./engine/rule-engine";

export type { StateMachine } from "./engine/state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./engine/state-machine";

export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./engine/validation-engine";

// === Schema registry ===

export { generateDrizzleSchemaFile } from "./schema/generate-drizzle-schema";
export { createLinkRegistry, LinkRegistry } from "./schema/link-registry";
export { createInterfaceRegistry, InterfaceRegistry } from "./schema/schema-interface";
export { createSchemaRegistry, SchemaRegistry } from "./schema/schema-registry";
export {
  buildColumn,
  buildSystemColumns,
  buildTableColumns,
  convertSchemaRelationshipFieldsToImplicitLinks,
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateLinkColumns,
  type LinkColumnsResult,
} from "./schema/schema-to-drizzle";

// === Event bus ===

export { createEventBus, EventBus, EventHandlerRegistry } from "./event/event-bus";
export {
  createOutboxWorker,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./event/outbox-worker";
export { createPersistentEventBus, PersistentEventBus } from "./event/persistent-event-bus";

// === Cache ===

export {
  type CacheEntry,
  CacheManager,
  type CacheManagerOptions,
  type CacheProvider,
  type CacheSetOptions,
  type CacheStats,
  type InMemoryCacheOptions,
  InMemoryCacheProvider,
  type NamespacedCache,
} from "./cache";

// === Observability ===

export { consoleLogger } from "./observability/console-logger";
export { InMemoryExecutionLogger } from "./observability/execution-logger";
export {
  InMemoryMetricsCollector,
  type MetricSnapshot,
  type MetricsCollector,
  noopMetricsCollector,
} from "./observability/metrics";
export {
  getCurrentTrace,
  getTraceDepth,
  type TraceState,
  withTrace,
} from "./observability/trace-context";

// === AI service ===

export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "./ai/ai-service";

// === AI Boundary (server-only — heavyweight runtime classes) ===

export { AIBoundary, AIBoundaryError } from "./ai";

// === AI Audit (server-only — compliance audit trail) ===

export {
  type AIAuditEntry,
  type AIAuditEventType,
  AIAuditLogger,
  type AIAuditLoggerOptions,
  type AIAuditQueryOptions,
  type AIAuditRiskLevel,
} from "./ai";

// === AI Prompt Sanitizer (server-only — injection detection + PII redaction) ===

export {
  detectInjection,
  type InjectionDetectionConfig,
  type InjectionDetectionResult,
  type InjectionPattern,
  type PIIPattern,
  type PIISanitizationConfig,
  type PIISanitizationResult,
  type PIIType,
  type PromptSanitizerOptions,
  type SanitizationResult,
  sanitizePII,
  sanitizePrompt,
  sanitizeRecordForAI,
} from "./ai";

// === Security: data masking (server-only — uses node:crypto) ===

export {
  canUnmask,
  type MaskRecordOptions,
  maskRecord,
  maskRecords,
  maskValue,
  resolveFieldMasking,
} from "./security";

// === Flow engine ===

export {
  type CompiledFlow,
  checkRestateHealth,
  compileFlow,
  createFlowRegistry,
  createFlowStepContext,
  createRestateEndpoint,
  createRestateFlowEngine,
  createSyncFlowEngine,
  createTriggerBinding,
  type FlowCompiler,
  type FlowEngine,
  type FlowEngineConfig,
  type FlowRegistry,
  FlowRegistryImpl,
  type FlowStepContext,
  type FlowStepContextDeps,
  type RestateConfig,
  registerDeployment,
  setupRestateEndpoint,
  type TriggerBinding,
} from "./flow";

// === Persistence: database, Drizzle ORM, migrations, system tables ===

export {
  checkConnection,
  closeDatabase,
  createDatabase,
  type DatabaseConfig,
} from "./persistence/database";
export { DrizzleApprovalStore } from "./persistence/drizzle-approval-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./persistence/drizzle-data-provider";
export { DrizzleExecutionLogger } from "./persistence/drizzle-execution-logger";
export * as drizzleSchema from "./persistence/drizzle-schema";
export { DrizzleTransactionManager } from "./persistence/drizzle-transaction-manager";
export { type MigrateOptions, runMigrations } from "./persistence/migrate";
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  linchkitSchema,
} from "./persistence/system-tables";
export { TableRegistry } from "./persistence/table-registry";

// === Security: tenant isolation ===

export {
  createTenantAwareDataProvider,
  createTenantIsolationMiddleware,
  defaultTenantResolver,
  type TenantIsolationMiddlewareOptions,
  type TenantResolver,
} from "./security/tenant-isolation";

// === Ontology: unified semantic facade ===

export {
  createOntologyRegistry,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
  type SchemaDescriptor,
} from "./ontology";

// === Deployment: health checks, graceful shutdown, environment ===

export {
  type AggregatedHealthStatus,
  createDatabaseCheck,
  createSchemaCheck,
  detectEnvironment,
  type EnvironmentConfig,
  type EnvironmentFeatureFlags,
  type EnvironmentName,
  GracefulShutdownManager,
  type GracefulShutdownManagerOptions,
  type HealthCheckFn,
  HealthCheckRegistry,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
  type HealthStatus,
  livenessCheck,
  type ShutdownHook,
  type ShutdownPhase,
  type ShutdownStatus,
  validateRequiredEnvVars,
} from "./deployment";

// === Legacy migration utilities ===

export {
  CSVImportSource,
  type CSVImportSourceOptions,
  DataImporter,
  type DataImporterOptions,
  type ErrorMode,
  type FieldMapping,
  type ImportProgress,
  type ImportRecordError,
  type ImportResult,
  type ImportSource,
  JSONImportSource,
  type JSONImportSourceOptions,
  type MappedRecord,
  type MappingValidationResult,
  type MigrationPlan,
  type MigrationResult,
  MigrationResumeTracker,
  MigrationRunner,
  type MigrationRunnerOptions,
  SchemaMapper,
} from "./migration";

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
  validateCapabilityDoc,
  validateSchemaDoc,
} from "./governance";

// === Documentation: API doc generation, Markdown, OpenAPI ===

export {
  type ActionDoc,
  type ApiDocGeneratorOptions,
  actionToDoc,
  type FieldDoc,
  fieldToDoc,
  generateApiDoc,
  generateOpenAPISpec,
  type MarkdownRenderOptions,
  type OpenAPIGeneratorOptions,
  type OpenAPIOperation,
  type OpenAPIPathItem,
  type OpenAPISchemaObject,
  type OpenAPISpec,
  renderActionDoc,
  renderSchemaDoc,
  renderSystemDoc,
  type SchemaDoc,
  type SystemDoc,
  schemaToDoc,
} from "./documentation";

// === Methodology: code quality, project structure, convention checking ===

export {
  type ActionInfo,
  type CommitInfo,
  checkActionDefinitions,
  checkCommitMessages,
  checkFileNaming,
  checkImportPatterns,
  checkSchemaDefinitions,
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
