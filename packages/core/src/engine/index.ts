/**
 * Engine module — runtime engines for core abstractions.
 */

// Rule engine
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
export { evaluateRules, type RuleEvalInput, type RuleEvalOutput } from "./rule-engine";
export type { StateMachine } from "./state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./state-machine";
