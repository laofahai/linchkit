/**
 * @linchkit/devtools — Testing tools + development debugging
 *
 * testRule / testStateMachine / validateCapability / getAvailableTransitions
 */

export const VERSION = "0.0.1";

export { testRule } from "./test-rule";
export type { TestRuleInput } from "./test-rule";

export { testStateMachine, getAvailableTransitions } from "./test-state";
export type { TestTransitionInput } from "./test-state";

export { validateCapability } from "./validate-capability";
export type { CapabilityValidationResult, ValidationIssue } from "./validate-capability";
