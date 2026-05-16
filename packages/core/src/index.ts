/**
 * @linchkit/core — Core runtime
 *
 * Browser-safe entry point: types, define functions, errors, config,
 * and pure-logic utilities (condition evaluator, Zod generator, translatable).
 *
 * For runtime engines, database, event bus, flow — use:
 *   import { ... } from "@linchkit/core/server"
 */

export const VERSION = "0.0.1";

export type {
  AIActionAccess,
  AIBoundaryCheckResult,
  AIBoundaryOptions,
  AIBudget,
  AIBudgetConfig,
  AICallRequest,
  AIContentFilter,
  AIPolicy,
  AIRateLimits,
  AIUsageRecord,
} from "./ai";
// AI Boundary — runtime classes exported from server-entry.ts only
// WatcherEngine concrete impl moved to @linchkit/cap-ai-provider
// (Spec 56 Phase 2 Step 2c); core retains the abstract `Watcher` interface
// (see `./life-system/watcher.ts`) and the WatcherRegistry.
export type { WatcherRegistry } from "./automation";
// Cache — type exports (browser-safe)
export type {
  CacheEntry,
  CacheManagerOptions,
  CacheProvider,
  CacheSetOptions,
  CacheStats,
  InMemoryCacheOptions,
  NamespacedCache,
} from "./cache";
// Capability Hub — discovery and dependency management
// Capability extension resolver — bridge override resolution
// Capability local registry — file-based capability tracking
export type {
  ActionOverrideEntry,
  CapabilityDependency,
  CapabilityManifest,
  CapabilityProvides,
  CapabilityRequires,
  CapabilitySearchOptions,
  CompatibilityIssue,
  EntityExtensionEntry,
  EntityOverrideEntry,
  ExtensionResolver,
  RegistryEntry,
  RegistrySearchOptions,
  ResolutionConflict,
  RuleOverrideEntry,
  TrustLevel,
  ValidationResult,
} from "./capability";
export {
  buildActionChain,
  CapabilityHub,
  CapabilityHubError,
  checkTrustPermissions,
  createCapabilityHub,
  createExtensionResolver,
  createLocalRegistry,
  filterEntityByCapabilities,
  LocalCapabilityRegistry,
  satisfiesVersionRange,
} from "./capability";
// Config center
export type {
  ConfigEntry,
  ConfigSchemaRef,
  ConfigScope,
  ConfigScopeRef,
  ConfigStore,
  ConfigValueHistoryEntry,
  ConfigVersion,
  SetConfigOptions,
} from "./config";
export {
  ConfigRegistry,
  ConfigValidationError,
  DEFAULT_EXECUTION_META_MASKED_KEYS,
  databaseConfig,
  defineConfigSchema,
  executionConfig,
  InMemoryConfigStore,
  queueConfig,
  RuntimeConfigRegistry,
  resolveWithCascade,
  securityConfig,
  serverConfig,
} from "./config";
// Define function exports
export {
  defineAction,
  defineCapability,
  defineConfig,
  defineDataAccess,
  defineEntity,
  defineEvent,
  defineEventHandler,
  defineInterface,
  definePermissionGroup,
  defineRelation,
  defineRule,
  defineState,
  defineView,
  defineWatcher,
  disableRule,
  extendEntity,
  extendPermissionGroup,
  extendState,
  extendView,
  overrideAction,
  overrideEntity,
  overrideRule,
} from "./define";
// Doctor — project health check registry
export type {
  CheckCategory,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
} from "./doctor";
export { clearDoctorChecks, getDoctorChecks, registerDoctorCheck } from "./doctor";
// Type re-exports from engine interfaces (browser-safe — type-only, no runtime code pulled in)
// Class types (exported as type-only so consumers can use for annotations without pulling runtime)
export type {
  ActionExecutor,
  ActionExecutorOptions,
  ActionRegistry,
  DataProvider,
  DataQueryOptions,
  ExecuteOptions,
  ExecutionChannel,
  PendingEvent,
  TransactionManager,
} from "./engine/action-engine";
export type {
  ApprovalEngine,
  ApprovalEngineOptions,
  CreateApprovalOptions,
} from "./engine/approval-engine";
export type {
  CommandBatchExecuteOptions,
  CommandContext,
  CommandExecuteOptions,
  CommandLayer,
  CommandLayerOptions,
  MiddlewareHandler,
  MiddlewareRegistration,
  SlotName,
} from "./engine/command-layer";
// Pure-logic utilities (no server deps)
export {
  type ConditionContext,
  evaluateCondition,
  resolveField,
} from "./engine/condition-evaluator";
export {
  canAutoApproveOverlayChange,
  canAutoApproveOverlayProposal,
  executeOverlayProposal,
} from "./engine/overlay-proposal-executor";
export type { PermissionRegistry } from "./engine/permission-engine";
export type { CreateProposalOptions, ProposalEngine } from "./engine/proposal-engine";
export type { ProposalGeneratorDeps } from "./engine/proposal-generator";
export type {
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
} from "./engine/rule-engine";
export type { StateMachine } from "./engine/state-machine";
export type { ValidationContext } from "./engine/validation-engine";
export {
  type AggregateDerived,
  type CascadeTarget,
  type ConcatDerived,
  computeAggregate,
  createDerivedPropertyEngine,
  type DerivedConfig,
  type DerivedFieldInfo,
  DerivedPropertyEngine,
  type ExpressionDerived,
  evaluateExpression,
  type FunctionDerived,
  getDerivedStrategy,
  isDerivedField,
  resolveAggregateValue,
  resolveDerivedValue,
} from "./entity/derived-property";
export type { InterfaceRegistry } from "./entity/entity-interface";
export { createInterfaceRegistry } from "./entity/entity-interface";
export type { EntityRegistry } from "./entity/entity-registry";
export { MERGEABLE_CONSTRAINT_KEYS, mergeFieldDefinition } from "./entity/entity-registry";
export { generateZodSchema, type ZodGeneratorOptions } from "./entity/entity-to-zod";
export type { RelationRegistry } from "./entity/relation-registry";
export { createRelationRegistry } from "./entity/relation-registry";
export {
  createTranslatableValue,
  getTranslatableFields,
  I18N_RAW_KEY,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
  TRANSLATABLE_FIELD_TYPES,
  type TranslatableValue,
  validateTranslatableEntity,
  wrapTranslatableValue,
} from "./entity/translatable";
export {
  generateExpressionIndex,
  generateGinIndex,
  generateTranslatableIndexes,
} from "./entity/translatable-index";
export type { ToResponseOptions } from "./errors";
// Error classes
export {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  isAiAgentCaller,
  LinchKitError,
  NotFoundError,
  SystemError,
  shouldIncludeErrorContext,
  ValidationError,
} from "./errors";
export type { EventBus, EventHandlerRegistry } from "./event/event-bus";
export type {
  BatchReplayResult,
  EventDetail,
  EventListOptions,
  EventReplayService,
  EventReplayServiceOptions,
  EventSummary,
  HandlerExecution,
  HandlerHistoryQuery,
  ReplayError,
  ReplayOptions,
  ReplayResult,
} from "./event/event-replay-service";
export type {
  FlowEngine,
  FlowRegistry,
  FlowStepContext,
  FlowStepContextDeps,
  TriggerBinding,
} from "./flow";
// i18n — shared types, locale utilities, and core label resolver
export {
  detectLocale,
  type I18nConfig,
  initI18n,
  parseAcceptLanguage,
  registerTranslations,
  resolveLabel,
  resolveLocale,
  type SupportedLanguage,
} from "./i18n";
export type {
  BacktestResult,
  ConflictFinding,
  ConflictResult,
  CreateDedupAnalyzerOptions,
  CreateImpactAnalyzerOptions,
  CreatePreAnalysisPipelineOptions,
  DedupResult,
  Detector,
  EvolutionRuntime,
  EvolutionRuntimeOptions,
  ImpactDataProvider,
  ImpactResult,
  InsightTranslator,
  InsightTranslatorKey,
  InsightTranslatorRegistry,
  LifecycleBaseline,
  LifecycleMemoryStore,
  LifecycleSensor,
  LifecycleSignal,
  MemoryStoreListOptions,
  MemoryStoreListPage,
  MemoryStoreWriteOptions,
  PendingProposalStore,
  PreAnalysisPipeline,
  PreAnalysisStage,
  PreAnalysisStageResult,
  PreAnalysisStatus,
  PreAnalyzer,
  ProposalPreAnalysisResult,
  SensorDefinitionConfig,
  SignalBus,
  SignalBusOptions,
  SignalHandler,
  TranslatorContext,
  Unsubscribe,
  Watcher,
} from "./life-system";
// Life-system — Sense layer (Spec 55) + Proposal pre-analysis (Spec 55 §7.3)
// Spec 56 Phase 2 Step 2a adds lifecycle-style Sensor/Signal/Baseline/MemoryStore
// abstractions (Lifecycle* prefix) plus the lifecycle-sensor registry helpers
// (registerSensor & friends). `clearSensors` is intentionally NOT re-exported
// here — it's a test-only helper, available via `./life-system` and the
// sensor-registry module path.
export {
  createDedupAnalyzer,
  createDefaultInsightTranslatorRegistry,
  createDispatchQuery,
  createEvolutionRuntime,
  createImpactAnalyzer,
  createInsightTranslatorRegistry,
  createPreAnalysisPipeline,
  createSignalBus,
  defineSensor,
  findSensor,
  getSensors,
  registerSensor,
  unregisterSensor,
} from "./life-system";
export type {
  AlertCondition,
  AlertEffect,
  AlertEvaluationResult,
  AlertOperator,
  AlertSeverity,
  SystemAlertDefinition,
} from "./observability/alert-engine";
export type {
  Counter,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricAttributes,
  MetricAttributeValue,
} from "./observability/meter";
export { NoopMeter, noopMeter } from "./observability/meter";
export type { MetricSnapshot, MetricsCollector, MetricsSummary } from "./observability/metrics";
export type { Observability } from "./observability/observability-registry";
export {
  getObservability,
  resetObservability,
  setObservability,
} from "./observability/observability-registry";
export type {
  LogLevel,
  LogSink,
  StructuredLogEntry,
  StructuredLoggerOptions,
} from "./observability/structured-logger";
export type { TraceState } from "./observability/trace-context";
export type {
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  StartSpanOptions,
  Tracer,
} from "./observability/tracer";
export { NoopTracer, noopTracer } from "./observability/tracer";
export type {
  EntityDescriptor,
  OntologyRegistry,
  OntologyRegistryDeps,
  RelationDescriptor,
} from "./ontology";
export {
  type ActionDescription,
  type AgentsMdOptions,
  buildProjectOverview,
  buildRelationGraph,
  type DescribeInput,
  describeAction,
  describeEntity,
  describeRelation,
  type EntityDescription,
  type FieldDescription,
  generateAgentsMd,
  inferSemanticRelations,
  type ProjectOverview,
  type RelationDescription,
} from "./ontology";
// Runtime override resolution (Layer 2 tenant overrides — pure logic, browser-safe)
export {
  applyOverride,
  deepMerge,
  type Overridable,
  resolveOverrides,
  resolveRuleOverride,
} from "./runtime/override-resolver";
// Security — data masking types only (runtime functions in server-entry.ts due to node:crypto dep)
export type { MaskRecordOptions } from "./security";
// Type exports
export type * from "./types";
// Non-type exports from types
export {
  capabilityCategoryEnum,
  capabilityMetadataSchema,
  capabilityTypeEnum,
  createExecutionMeta,
  DEFAULT_META_MAX_BYTES,
  ERROR_STATUS_MAP,
  MetaSizeError,
  redactMetaForLog,
  stripSystemKeys,
  validateCapabilityMetadata,
} from "./types";
export type { ErrorContext } from "./types/error";
export type { Logger } from "./types/logger";
export type { PermissionGroupDefinition } from "./types/permission";
export type {
  RelationGraph,
  SemanticRelation,
  SemanticRelationEndpoint,
  SemanticRelationSource,
  SemanticRelationType,
} from "./types/semantic-relation";
export { defineSemanticRelation } from "./types/semantic-relation";
// Utilities
export { resolveEnvVars } from "./utils/env";
export type { IdentifierValidationResult } from "./utils/identifier";
export { validateIdentifier } from "./utils/identifier";
// View layout chain builder — parallel ergonomic API to the helpers above
export { type FormLayoutBuilder, formLayout } from "./view/form-layout-builder";
// View layout helpers — syntactic sugar over FormLayoutNode JSON shape
export {
  type FieldOptions,
  field,
  group,
  notebook,
  page,
  row,
  separator,
} from "./view/layout-helpers";
