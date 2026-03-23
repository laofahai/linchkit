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

// Config center
export type { ConfigSchemaRef } from "./config";
export {
  ConfigRegistry,
  databaseConfig,
  defineConfigSchema,
  queueConfig,
  securityConfig,
  serverConfig,
} from "./config";

// Define function exports
export {
  defineAction,
  defineCapability,
  defineConfig,
  defineDataAccess,
  defineEvent,
  defineEventHandler,
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
export type { TraceState } from "./observability/trace-context";
export type { LinkRegistry } from "./schema/link-registry";
export { createLinkRegistry } from "./schema/link-registry";
export type { SchemaRegistry } from "./schema/schema-registry";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema/schema-to-zod";
export {
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  type TranslatableValue,
  wrapTranslatableValue,
} from "./schema/translatable";

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
