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
  ModelPricing,
} from "./ai";
// AI Boundary — runtime classes exported from server-entry.ts only
export type {
  AutomationEngine,
  AutomationRegistry,
  WatcherEngine,
  WatcherRegistry,
} from "./automation";
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
  ExtensionResolver,
  RegistryEntry,
  RegistrySearchOptions,
  ResolutionConflict,
  RuleOverrideEntry,
  EntityExtensionEntry,
  EntityOverrideEntry,
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
  filterSchemaByCapabilities,
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
  databaseConfig,
  defineConfigSchema,
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
  defineAutomation,
  defineCapability,
  defineConfig,
  defineDataAccess,
  defineEvent,
  defineEventHandler,
  defineInterface,
  defineRelation,
  definePermissionGroup,
  defineRule,
  defineEntity,
  defineState,
  defineView,
  defineWatcher,
  disableRule,
  extendPermissionGroup,
  extendSchema,
  extendState,
  extendView,
  overrideAction,
  overrideRule,
  overrideSchema,
} from "./define";
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
// Error classes
export {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "./errors";
export type { EventBus, EventHandlerRegistry } from "./event/event-bus";
export type {
  FlowEngine,
  FlowRegistry,
  FlowStepContext,
  FlowStepContextDeps,
  TriggerBinding,
} from "./flow";
// i18n — shared types and locale utilities
export {
  type I18nConfig,
  parseAcceptLanguage,
  resolveLocale,
  type SupportedLanguage,
} from "./i18n";
export type {
  SensorDefinitionConfig,
  SignalBus,
  SignalBusOptions,
  SignalHandler,
} from "./life-system";
// Life-system — Sense layer (Spec 55)
export { createSignalBus, defineSensor } from "./life-system";
export type {
  AlertCondition,
  AlertEffect,
  AlertEvaluationResult,
  AlertOperator,
  AlertSeverity,
  SystemAlertDefinition,
} from "./observability/alert-engine";
export type { MetricSnapshot, MetricsCollector, MetricsSummary } from "./observability/metrics";
export type {
  LogLevel,
  LogSink,
  StructuredLogEntry,
  StructuredLoggerOptions,
} from "./observability/structured-logger";
export type { TraceState } from "./observability/trace-context";
export type {
  OntologyRegistry,
  OntologyRegistryDeps,
  RelationDescriptor,
  EntityDescriptor,
} from "./ontology";
export { buildRelationGraph, inferSemanticRelations } from "./ontology";
// Runtime override resolution (Layer 2 tenant overrides — pure logic, browser-safe)
export {
  applyOverride,
  deepMerge,
  type Overridable,
  resolveOverrides,
  resolveRuleOverride,
} from "./runtime/override-resolver";
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
} from "./schema/derived-property";
export type { RelationRegistry } from "./schema/relation-registry";
export { createRelationRegistry } from "./schema/relation-registry";
export type { InterfaceRegistry } from "./schema/entity-interface";
export { createInterfaceRegistry } from "./schema/entity-interface";
export type { EntityRegistry } from "./schema/entity-registry";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema/entity-to-zod";
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
  validateTranslatableSchema,
  wrapTranslatableValue,
} from "./schema/translatable";
// Security — data masking types only (runtime functions in server-entry.ts due to node:crypto dep)
export type { MaskRecordOptions } from "./security";
// Type exports
export type * from "./types";
// Non-type exports from types
export {
  capabilityCategoryEnum,
  capabilityMetadataSchema,
  capabilityTypeEnum,
  ERROR_STATUS_MAP,
  validateCapabilityMetadata,
} from "./types";
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
