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
  CommandContext,
  CommandExecuteOptions,
  CommandLayer,
  CommandLayerOptions,
  ConditionContext,
  DataProvider,
  DrizzleGeneratorOptions,
  ExecuteOptions,
  ExecutionChannel,
  MiddlewareHandler,
  MiddlewareRegistration,
  RuleEvalInput,
  RuleEvalOutput,
  SlotName,
  StateMachine,
  ZodGeneratorOptions,
} from "./engine";
// Engine exports
export {
  ActionRegistry,
  canTransition,
  checkActionPermission,
  createActionExecutor,
  createCommandLayer,
  createSchemaRegistry,
  createStateMachine,
  ExposureError,
  evaluateCondition,
  evaluateRules,
  generateDrizzleTable,
  generateZodSchema,
  getAvailableActions,
  InMemoryExecutionLogger,
  PermissionRegistry,
  PipelineError,
  resolveConditionVariables,
  resolveDataAccess,
  resolveField,
  SchemaRegistry,
  transition,
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
