/**
 * @linchkit/core — Core runtime
 *
 * Meta-model definitions (defineXxx) and type system.
 * Future: Action/Rule/State/Event/Schema engines.
 */

export const VERSION = "0.0.1";

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
  DatabaseConfig,
  DataProvider,
  DrizzleGeneratorOptions,
  ExecuteOptions,
  ExecutionChannel,
  MiddlewareHandler,
  MiddlewareRegistration,
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
  SlotName,
  StateMachine,
  ValidationContext,
  ZodGeneratorOptions,
} from "./engine";
// Engine exports
export {
  ActionRegistry,
  approvalStatusEnum,
  approvalsTable,
  bumpVersion,
  canTransition,
  checkActionPermission,
  closeDatabase,
  consoleLogger,
  createActionExecutor,
  createAIService,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createDatabase,
  createNoopAIService,
  createProposalEngine,
  createSchemaRegistry,
  createStateMachine,
  defaultAIConfig,
  DrizzleDataProvider,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  ExposureError,
  evaluateCondition,
  evaluateRules,
  generateDrizzleTable,
  generateZodSchema,
  getAvailableActions,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  PermissionRegistry,
  PipelineError,
  ProposalEngine,
  resolveConditionVariables,
  resolveDataAccess,
  resolveField,
  resolveModel,
  SchemaRegistry,
  TableRegistry,
  transition,
  validatePhase1,
  validateProposal,
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
export { ERROR_STATUS_MAP } from "./types";
export type { Logger } from "./types/logger";

// Utilities
export { resolveEnvVars } from "./utils/env";
