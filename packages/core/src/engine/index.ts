/**
 * Engine module — runtime engines for core abstractions.
 */

// Rule engine
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
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
