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
  defineEvent,
  defineEventHandler,
  defineRule,
  defineSchema,
  defineState,
  defineView,
  disableRule,
  extendSchema,
  extendState,
  extendView,
  overrideAction,
  overrideRule,
  overrideSchema,
} from "./define";
export type {
  ConditionContext,
  DrizzleGeneratorOptions,
  RuleEvalInput,
  RuleEvalOutput,
  StateMachine,
  ZodGeneratorOptions,
} from "./engine";
// Engine exports
export {
  canTransition,
  createSchemaRegistry,
  createStateMachine,
  evaluateCondition,
  evaluateRules,
  generateDrizzleTable,
  generateZodSchema,
  getAvailableActions,
  resolveField,
  SchemaRegistry,
  transition,
} from "./engine";
// Error classes
export {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  SystemError,
  ValidationError,
} from "./errors";
// Type exports
export type * from "./types";

// Non-type exports
export { ERROR_STATUS_MAP } from "./types";
