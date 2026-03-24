/**
 * @linchkit/devtools — Testing tools + development debugging
 *
 * testRule / testStateMachine / validateCapability / getAvailableTransitions
 */

export const VERSION = "0.0.1";

export type { TestRuleInput } from "./test-rule";
export { testRule } from "./test-rule";
export type { MockAIService, TestRuntime, TestRuntimeOptions } from "./test-runtime";
export { createTestActor, createTestRuntime, mockAIService } from "./test-runtime";
export type { TestTransitionInput } from "./test-state";
export { getAvailableTransitions, testStateMachine } from "./test-state";
export type { CapabilityValidationResult, ValidationIssue } from "./validate-capability";
export { validateCapability } from "./validate-capability";
