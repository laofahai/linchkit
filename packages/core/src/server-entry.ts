/**
 * @linchkit/core/server — Server-only modules
 *
 * Runtime engines, database, Drizzle ORM, event bus, flow, observability, AI.
 * NOT safe for browser — requires Node/Bun runtime.
 *
 * Usage: import { createActionExecutor, SchemaRegistry } from "@linchkit/core/server"
 */

// === Engine: action, command, approval, state, rule, validation, permission, proposal ===

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
} from "./engine/action-engine";

export {
  type ApprovalEngine,
  type ApprovalEngineOptions,
  type CreateApprovalOptions,
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "./engine/approval-engine";

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
} from "./engine/command-layer";

export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./engine/permission-engine";

export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  ProposalEngine,
} from "./engine/proposal-engine";

export {
  createProposalGenerator,
  ProposalGenerationError,
  type ProposalGeneratorDeps,
} from "./engine/proposal-generator";

export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./engine/rule-engine";

export type { StateMachine } from "./engine/state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./engine/state-machine";

export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./engine/validation-engine";

// === Schema registry ===

export { generateDrizzleSchemaFile } from "./schema/generate-drizzle-schema";
export { createLinkRegistry, LinkRegistry } from "./schema/link-registry";
export { createSchemaRegistry, SchemaRegistry } from "./schema/schema-registry";
export {
  buildColumn,
  buildSystemColumns,
  buildTableColumns,
  convertSchemaRelationshipFieldsToImplicitLinks,
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateLinkColumns,
  type LinkColumnsResult,
} from "./schema/schema-to-drizzle";

// === Event bus ===

export { createEventBus, EventBus, EventHandlerRegistry } from "./event/event-bus";
export {
  createOutboxWorker,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./event/outbox-worker";
export { createPersistentEventBus, PersistentEventBus } from "./event/persistent-event-bus";

// === Observability ===

export { consoleLogger } from "./observability/console-logger";
export { InMemoryExecutionLogger } from "./observability/execution-logger";
export {
  getCurrentTrace,
  getTraceDepth,
  type TraceState,
  withTrace,
} from "./observability/trace-context";

// === AI service ===

export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "./ai/ai-service";

// === Flow engine ===

export {
  checkRestateHealth,
  type CompiledFlow,
  compileFlow,
  createFlowRegistry,
  createFlowStepContext,
  createRestateEndpoint,
  createRestateFlowEngine,
  createSyncFlowEngine,
  createTriggerBinding,
  type FlowCompiler,
  type FlowEngine,
  type FlowEngineConfig,
  type FlowRegistry,
  FlowRegistryImpl,
  type FlowStepContext,
  type FlowStepContextDeps,
  registerDeployment,
  type RestateConfig,
  setupRestateEndpoint,
  type TriggerBinding,
} from "./flow";

// === Persistence: database, Drizzle ORM, migrations, system tables ===

export { checkConnection, closeDatabase, createDatabase, type DatabaseConfig } from "./persistence/database";
export { DrizzleApprovalStore } from "./persistence/drizzle-approval-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./persistence/drizzle-data-provider";
export { DrizzleExecutionLogger } from "./persistence/drizzle-execution-logger";
export * as drizzleSchema from "./persistence/drizzle-schema";
export { DrizzleTransactionManager } from "./persistence/drizzle-transaction-manager";
export { type MigrateOptions, runMigrations } from "./persistence/migrate";
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  linchkitSchema,
} from "./persistence/system-tables";
export { TableRegistry } from "./persistence/table-registry";

// === Ontology: unified semantic facade ===

export {
  createOntologyRegistry,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
  type SchemaDescriptor,
} from "./ontology";
