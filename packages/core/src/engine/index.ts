/**
 * Engine module — runtime engines for core abstractions.
 *
 * After the directory restructure, this barrel re-exports from
 * engine/ (business engines) and sibling directories so that
 * existing `import { … } from "./engine"` in index.ts keeps working.
 */

// === Business engines (local) ===

// Action engine
export {
  type ActionExecutor,
  type ActionExecutorOptions,
  ActionRegistry,
  createActionExecutor,
  type DataProvider,
  type DataQueryOptions,
  type ExecuteOptions,
  type ExecutionChannel,
  type PendingEvent,
  type TransactionManager,
} from "./action-engine";
// Approval engine
export {
  type ApprovalEngine,
  type ApprovalEngineOptions,
  type CreateApprovalOptions,
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "./approval-engine";
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
// Condition evaluator
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
// Permission engine
export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./permission-engine";
// Proposal engine
export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  ProposalEngine,
} from "./proposal-engine";
// Proposal generator (AI-powered)
export {
  createProposalGenerator,
  type ProposalGeneratorDeps,
} from "./proposal-generator";
// Rule engine
export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./rule-engine";
// State machine
export type { StateMachine } from "./state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./state-machine";
// Validation engine
export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./validation-engine";

// === Re-exports from sibling directories ===

// AI service
export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "../ai";
// Observability
export { consoleLogger } from "../observability";
export { InMemoryExecutionLogger } from "../observability";
export { getCurrentTrace, getTraceDepth, type TraceState, withTrace } from "../observability";
// Event bus
export { createEventBus, EventBus, EventHandlerRegistry } from "../event";
// Schema
export { createSchemaRegistry, SchemaRegistry } from "../schema";
export { generateZodSchema, type ZodGeneratorOptions } from "../schema";
export {
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  type TranslatableValue,
  wrapTranslatableValue,
} from "../schema";
// Flow engine
export {
  type CompiledFlow,
  compileFlow,
  createFlowRegistry,
  createFlowStepContext,
  createSyncFlowEngine,
  createTriggerBinding,
  type FlowCompiler,
  type FlowEngine,
  type FlowEngineConfig,
  type FlowRegistry,
  FlowRegistryImpl,
  type FlowStepContext,
  type FlowStepContextDeps,
  type RestateConfig,
  type TriggerBinding,
} from "../flow";
