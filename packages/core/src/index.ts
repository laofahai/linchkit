/**
 * @linchkit/core — Core runtime
 *
 * Meta-model definitions (defineXxx) and type system.
 * Future: Action/Rule/State/Event/Schema engines.
 */

export const VERSION = "0.0.1";

export type { ConfigSchemaRef } from "./config";
// Config center
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
export type {
  ActionExecutor,
  ActionExecutorOptions,
  ApprovalEngine,
  ApprovalEngineOptions,
  CommandContext,
  CommandExecuteOptions,
  CommandLayer,
  CommandLayerOptions,
  ConditionContext,
  CreateApprovalOptions,
  CreateProposalOptions,
  DataProvider,
  DataQueryOptions,
  ExecuteOptions,
  ExecutionChannel,
  FlowStepContextDeps,
  MiddlewareHandler,
  MiddlewareRegistration,
  PendingEvent,
  ProposalGeneratorDeps,
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
  SlotName,
  StateMachine,
  TraceState,
  TransactionManager,
  ValidationContext,
  ZodGeneratorOptions,
} from "./engine";
// Engine exports (server-only modules → @linchkit/core/server)
export {
  ActionRegistry,
  bumpVersion,
  canTransition,
  checkActionPermission,
  consoleLogger,
  createActionExecutor,
  createAIService,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createEventBus,
  createFlowStepContext,
  createNoopAIService,
  createProposalEngine,
  createProposalGenerator,
  createSchemaRegistry,
  createStateMachine,
  defaultAIConfig,
  EventBus,
  EventHandlerRegistry,
  ExposureError,
  evaluateCondition,
  evaluateRules,
  generateZodSchema,
  getAvailableActions,
  getCurrentTrace,
  getTraceDepth,
  getTranslatableFields,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  PermissionRegistry,
  PipelineError,
  ProposalEngine,
  resolveConditionVariables,
  resolveDataAccess,
  resolveField,
  resolveModel,
  resolveTranslatableRow,
  resolveTranslatableValue,
  SchemaRegistry,
  transition,
  validatePhase1,
  validateProposal,
  withTrace,
  wrapTranslatableValue,
} from "./engine";
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
// Type exports
export type * from "./types";
// Non-type exports
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
