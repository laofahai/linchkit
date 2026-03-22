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
// Database connection manager
export { type DatabaseConfig, closeDatabase, createDatabase } from "./database";
// Drizzle data provider
export { DrizzleDataProvider } from "./drizzle-data-provider";
// Rule engine
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
// Console logger
export { consoleLogger } from "./console-logger";
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
// Proposal engine
export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  ProposalEngine,
} from "./proposal-engine";
export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./rule-engine";
// Schema registry
export { createSchemaRegistry, SchemaRegistry } from "./schema-registry";
// System tables
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
} from "./system-tables";
// Table registry
export { TableRegistry } from "./table-registry";
// Schema-to-Drizzle generator
export { type DrizzleGeneratorOptions, generateDrizzleTable } from "./schema-to-drizzle";
// Schema sync (dev mode)
export { type SyncOptions, syncTables } from "./schema-sync";
// Schema-to-Zod generator
export { generateZodSchema, type ZodGeneratorOptions } from "./schema-to-zod";
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
