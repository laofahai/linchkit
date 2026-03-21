/**
 * Engine module — runtime engines for core abstractions.
 */

// Action engine
export {
  type ActionExecutor,
  type ActionExecutorOptions,
  ActionRegistry,
  createActionExecutor,
  type DataProvider,
  type ExecuteOptions,
  type ExecutionChannel,
} from "./action-engine";
// Command layer
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
} from "./command-layer";
// Rule engine
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
// Event bus
export { createEventBus, EventBus, EventHandlerRegistry } from "./event-bus";
// Execution logger
export { InMemoryExecutionLogger } from "./execution-logger";
// Permission engine
export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./permission-engine";
export { evaluateRules, type RuleEvalInput, type RuleEvalOutput } from "./rule-engine";
// Schema registry
export { createSchemaRegistry, SchemaRegistry } from "./schema-registry";
// Schema-to-Drizzle generator
export { type DrizzleGeneratorOptions, generateDrizzleTable } from "./schema-to-drizzle";
// Schema-to-Zod generator
export { generateZodSchema, type ZodGeneratorOptions } from "./schema-to-zod";
export type { StateMachine } from "./state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./state-machine";
