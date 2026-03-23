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
  type DataQueryOptions,
  type ExecuteOptions,
  type ExecutionChannel,
} from "./action-engine";
// AI service
export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "./ai-service";
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
// Server-only modules → @linchkit/core/server
// Rule engine
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
// Console logger
export { consoleLogger } from "./console-logger";
// Event bus
export { createEventBus, EventBus, EventHandlerRegistry } from "./event-bus";
// Execution logger
export { InMemoryExecutionLogger } from "./execution-logger";
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
} from "./flow";
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
export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./rule-engine";
// Schema registry
export { createSchemaRegistry, SchemaRegistry } from "./schema-registry";
// Schema-to-Zod generator
export { generateZodSchema, type ZodGeneratorOptions } from "./schema-to-zod";
export type { StateMachine } from "./state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./state-machine";
// Translatable field helpers
export {
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  type TranslatableValue,
  wrapTranslatableValue,
} from "./translatable";
// Validation engine
export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./validation-engine";
