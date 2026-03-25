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
export type { AutomationEngine, AutomationRegistry } from "./automation";
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
export type {
  CapabilityDependency,
  CapabilityManifest,
  CapabilityProvides,
  CapabilityRequires,
  CapabilitySearchOptions,
  CompatibilityIssue,
  ValidationResult,
} from "./capability";
export {
  CapabilityHub,
  CapabilityHubError,
  createCapabilityHub,
  satisfiesVersionRange,
} from "./capability";
// Config center
export type { ConfigSchemaRef } from "./config";
export {
  ConfigRegistry,
  ConfigValidationError,
  databaseConfig,
  defineConfigSchema,
  queueConfig,
  RuntimeConfigRegistry,
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
  defineLink,
  definePermissionGroup,
  defineRule,
  defineSchema,
  defineState,
  defineView,
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
export type { PermissionGroupDefinition } from "./types/permission";
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
  CompiledFlow,
  FlowCompiler,
  FlowEngine,
  FlowEngineConfig,
  FlowRegistry,
  FlowStepContext,
  FlowStepContextDeps,
  RestateConfig,
  TriggerBinding,
} from "./flow";
export type { MetricSnapshot, MetricsCollector } from "./observability/metrics";
export type { TraceState } from "./observability/trace-context";
export type {
  OntologyRegistry,
  OntologyRegistryDeps,
  RelationDescriptor,
  SchemaDescriptor,
} from "./ontology";
export {
  type AggregateDerived,
  type ConcatDerived,
  createDerivedPropertyEngine,
  type DerivedConfig,
  type DerivedFieldInfo,
  DerivedPropertyEngine,
  type ExpressionDerived,
  evaluateExpression,
  type FunctionDerived,
  getDerivedStrategy,
  isDerivedField,
  resolveDerivedValue,
} from "./schema/derived-property";
export type { LinkRegistry } from "./schema/link-registry";
export { createLinkRegistry } from "./schema/link-registry";
export type { InterfaceRegistry } from "./schema/schema-interface";
export { createInterfaceRegistry } from "./schema/schema-interface";
export type { SchemaRegistry } from "./schema/schema-registry";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema/schema-to-zod";
export {
  createTranslatableValue,
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
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
// Utilities
export { resolveEnvVars } from "./utils/env";
export type { IdentifierValidationResult } from "./utils/identifier";
export { validateIdentifier } from "./utils/identifier";
export type {
  BreakingChange,
  CompatibilityCheckResult,
  MigrationResult,
  MigrationTransform,
  ReleaseCompatibilityResult,
  ReleaseType,
  RollbackMode,
  SchemaMigration,
  SemVer,
  TenantOverrideImpact,
  VersionEntry,
  VersionedEntityType,
  VersionQuery,
} from "./versioning";
// Versioning — release compatibility, migration, version tracking (spec 38)
export {
  analyzeCompatibility,
  applyMigration,
  classifyRelease,
  compareSemVer,
  createVersionRegistry,
  formatSemVer,
  getBreakingChanges,
  isCompatible,
  MigrationRegistry,
  parseSemVer,
  VersionRegistry,
  validateUpgrade,
} from "./versioning";
