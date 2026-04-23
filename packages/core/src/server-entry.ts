/**
 * @linchkit/core/server — Server-only modules
 *
 * Runtime engines, database, Drizzle ORM, event bus, flow, observability, AI.
 * NOT safe for browser — requires Node/Bun runtime.
 *
 * Usage: import { createActionExecutor, EntityRegistry } from "@linchkit/core/server"
 */

// === Watcher engine (data-condition automation, spec 45) ===

export {
  createWatcherEngine,
  createWatcherRegistry,
  evaluateComparison,
  parseDuration,
  type WatcherDataQuerier,
  type WatcherEngine,
  type WatcherEngineOptions,
  type WatcherRegistry,
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
  createOnchangeEvaluator,
  DEFAULT_COMPUTE_TIMEOUT_MS,
  MAX_CHAIN_DEPTH,
  type OnchangeEvaluateArgs,
  type OnchangeEvaluationResult,
  type OnchangeEvaluator,
  OnchangeEvaluatorError,
  type OnchangeEvaluatorOptions,
} from "./engine/onchange-evaluator";
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
  getAvailableTransitions,
  transition,
} from "./engine/state-machine";

export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./engine/validation-engine";

// === Schema registry ===

export {
  createDerivedPropertyEngine,
  DerivedPropertyEngine,
} from "./entity/derived-property";
export { createInterfaceRegistry, InterfaceRegistry } from "./entity/entity-interface";
export { createEntityRegistry, EntityRegistry } from "./entity/entity-registry";
export {
  buildColumn,
  buildSystemColumns,
  buildTableColumns,
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateRelationColumns,
  type RelationColumnsResult,
} from "./entity/entity-to-drizzle";
export { generateDrizzleSchemaFile } from "./entity/generate-drizzle-schema";
export { createRelationRegistry, RelationRegistry } from "./entity/relation-registry";

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
  CACHE_INVALIDATION_CHANNEL,
  type CacheEntry,
  type CacheInvalidationPayload,
  CacheManager,
  type CacheManagerOptions,
  type CacheProvider,
  type CacheSetOptions,
  type CacheStats,
  type InMemoryCacheOptions,
  InMemoryCacheProvider,
  type NamespacedCache,
  PostgresCacheInvalidator,
  type PostgresCacheInvalidatorOptions,
} from "./cache";

// === Observability ===

export {
  type AlertCondition,
  type AlertEffect,
  AlertEngine,
  type AlertEngineOptions,
  type AlertEvaluationResult,
  type AlertHandler,
  type AlertOperator,
  type AlertSeverity,
  defineSystemAlert,
  type SystemAlertDefinition,
} from "./observability/alert-engine";
export { consoleLogger } from "./observability/console-logger";
export { InMemoryExecutionLogger } from "./observability/execution-logger";
export {
  InMemoryMetricsCollector,
  type MetricSnapshot,
  type MetricsCollector,
  type MetricsSummary,
  noopMetricsCollector,
} from "./observability/metrics";
export {
  createStructuredLogger,
  createTestLogSink,
  type LogLevel,
  type LogSink,
  type StructuredLogEntry,
  type StructuredLoggerOptions,
} from "./observability/structured-logger";
export {
  getCurrentTrace,
  getTraceDepth,
  type TraceState,
  withTrace,
} from "./observability/trace-context";

// === AI service ===
// NOTE: createAIService and resolveLanguageModel moved to @linchkit/cap-ai-provider (Spec 56).
// Core retains only config helpers and the noop fallback.

export {
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
  resolveModelRoute,
  resolveTenantConfig,
  validateConfig as validateAIConfig,
} from "./ai/ai-service";

// === AI Cost Estimator (server-only) ===

export { CostEstimator, defaultCostEstimator } from "./ai";

// === AI Response Cache (server-only) ===

export { AIResponseCache } from "./ai";

// === AI Boundary (server-only — heavyweight runtime classes) ===

export { AIBoundary, AIBoundaryError } from "./ai";

// === AI Pattern Detection (server-only — analysis engine) ===

export type { PatternDetectorConfig, PatternEvidence, PatternInsight, PatternType } from "./ai";
export { PatternDetector } from "./ai";

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

// === AI Output Validator (server-only — output safety checks) ===

export {
  type OutputValidationResult,
  type OutputValidationRule,
  type OutputValidatorConfig,
  type OutputViolation,
  type OutputViolationSeverity,
  type OutputViolationType,
  sanitizeAIOutput,
  validateAIOutput,
} from "./ai";

// === AI Proposal Validator (server-only — proposal security checks) ===

export {
  createProposalValidator,
  type ProposalChange,
  type ProposalChangeType,
  type ProposalCustomRule,
  type ProposalRiskLevel,
  type ProposalValidationResult,
  type ProposalValidatorConfig,
  type ProposalViolation,
  validateProposal as validateAIProposal,
} from "./ai";

// === AI Anomaly Detector (server-only — behavioral anomaly detection) ===

export {
  type AnomalyDetection,
  AnomalyDetector,
  type AnomalyDetectorConfig,
  type AnomalySeverity,
  type AnomalyType,
  type UsageEvent,
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
  createFlowRegistry,
  createFlowStepContext,
  createSyncFlowEngine,
  createTriggerBinding,
  type FlowEngine,
  type FlowRegistry,
  FlowRegistryImpl,
  type FlowStepContext,
  type FlowStepContextDeps,
  type TriggerBinding,
} from "./flow";

// === Persistence: database, Drizzle ORM, system tables ===

export type { OverlayChangeListener, OverlayRegistry } from "./overlay/overlay-registry";
export { DefaultOverlayRegistry } from "./overlay/overlay-registry";
export type { PromotionPlan } from "./overlay/promote";
export { generateFieldCode, generateMigrationSql, generatePromotionPlan } from "./overlay/promote";
export {
  checkConnection,
  closeDatabase,
  createDatabase,
  type DatabaseConfig,
} from "./persistence/database";
export { DrizzleApprovalStore } from "./persistence/drizzle-approval-store";
export { DrizzleConfigStore } from "./persistence/drizzle-config-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./persistence/drizzle-data-provider";
export { DrizzleExecutionLogger } from "./persistence/drizzle-execution-logger";
export { DrizzleOverlayStore } from "./persistence/drizzle-overlay-store";
export * as drizzleSchema from "./persistence/drizzle-schema";
export { DrizzleTransactionManager } from "./persistence/drizzle-transaction-manager";
export { InMemoryOverlayStore } from "./persistence/in-memory-overlay-store";
export { type FindManyOptions, InMemoryStore } from "./persistence/in-memory-store";
export { OverlayAwareDataProvider } from "./persistence/overlay-aware-data-provider";
export {
  fieldOverlaysTable,
  overlayStatusEnum,
} from "./persistence/overlay-table";
export {
  approvalStatusEnum,
  approvalsTable,
  configScopeEnum,
  configTable,
  configVersionsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  linchkitSchema,
  overrideTargetTypeEnum,
  tenantOverridesTable,
} from "./persistence/system-tables";
export { TableRegistry } from "./persistence/table-registry";
export {
  type OverrideTargetType,
  type TenantOverride,
  TenantOverrideStore,
} from "./persistence/tenant-override-store";

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
  type EntityDescriptor,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
} from "./ontology";

// === Life-system: Sense layer (Spec 55) ===

export type {
  AwarenessEngineOptions,
  EvolutionRuntime,
  EvolutionRuntimeOptions,
  SensorDefinitionConfig,
  SignalBus,
  SignalBusOptions,
  SignalHandler,
} from "./life-system";
export {
  createAttentionBudget,
  createAwarenessEngine,
  createDispatchQuery,
  createEvolutionRuntime,
  createSignalBus,
  createUsageImportanceGraph,
  defineSensor,
} from "./life-system";

// === Deployment: health checks, graceful shutdown, environment ===

export {
  type AggregatedHealthStatus,
  createCacheCheck,
  createDatabaseCheck,
  createEntityCheck,
  createEventBusCheck,
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

// === Doctor — project health check registry + built-in checks ===

export type {
  CheckCategory,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
} from "./doctor";
export { builtinChecks, clearDoctorChecks, getDoctorChecks, registerDoctorCheck } from "./doctor";

// === Addon discovery (Spec 57) ===

export { scanAddonsPath } from "./capability/addon-scanner";
export { resolveAutoInstall } from "./capability/auto-install";
