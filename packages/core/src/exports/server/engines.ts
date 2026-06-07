/**
 * Engine runtime — action, batch, command, approval, state, rule, validation,
 * permission, proposal, onchange (server-only).
 */

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
} from "../../engine/action-engine";
export {
  type ApprovalEngine,
  type ApprovalEngineOptions,
  type CreateApprovalOptions,
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "../../engine/approval-engine";
// Batch action engine (Spec 04 §8, Spec 16 §2.1)
export {
  BatchValidationError,
  type ExecuteBatchOptions,
  executeBatch,
  MAX_BATCH_SIZE,
} from "../../engine/batch-action-engine";
export {
  type CommandBatchExecuteOptions,
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
} from "../../engine/command-layer";
export {
  type PersistCycleDraftsOptions,
  type PersistCycleDraftsResult,
  persistCycleProposalsAsDrafts,
} from "../../engine/evolution-cycle-drafts";
// Generator priority aggregator (Spec 55 §7.7 Phase 3)
export {
  createGeneratorPriorityAggregator,
  type GeneratorOutcomeType,
  GeneratorPriorityAggregator,
  type GeneratorPriorityAggregatorOptions,
  type GeneratorPriorityConfig,
  type GeneratorWeightRecord,
  type OutcomeObservation,
} from "../../engine/generator-priority-aggregator";
// Interceptors — value-returning capability → core extension points (Spec 63 Phase 3).
export {
  createInterceptorRegistry,
  type FieldLockCheckContext,
  type Interceptor,
  type InterceptorCatalog,
  type InterceptorPoint,
  type InterceptorRegistration,
  type InterceptorRegistry,
} from "../../engine/interceptors";
export {
  createOnchangeEvaluator,
  DEFAULT_COMPUTE_TIMEOUT_MS,
  MAX_CHAIN_DEPTH,
  type OnchangeEvaluateArgs,
  type OnchangeEvaluationResult,
  type OnchangeEvaluator,
  OnchangeEvaluatorError,
  type OnchangeEvaluatorErrorCode,
  type OnchangeEvaluatorOptions,
  type OnchangeReadPermissionCheck,
} from "../../engine/onchange-evaluator";
export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "../../engine/permission-engine";
export {
  createProposalEffectVerifier,
  type EffectVerificationPayload,
  type EffectVerificationRecord,
  type EffectVerificationResult,
  ProposalEffectVerifier,
  type ProposalEffectVerifierOptions,
  type VerifiableSignalStore,
  type VerifyAllOptions,
} from "../../engine/proposal-effect-verifier";
export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  type OnApprovedHook,
  type OnRejectedHook,
  ProposalEngine,
  type ProposalEngineOptions,
} from "../../engine/proposal-engine";
export {
  ProposalFileWriter,
  type ProposalFileWriterOptions,
  type ProposalFormatterOption,
  type ProposalSourceFormatter,
} from "../../engine/proposal-file-writer";
export {
  createProposalGenerator,
  ProposalGenerationError,
  type ProposalGeneratorDeps,
} from "../../engine/proposal-generator";
export {
  createProposalGitCommitter,
  type ProposalGhRunner,
  type ProposalGitCommitResult,
  ProposalGitCommitter,
  type ProposalGitCommitterOptions,
  type ProposalGitCommitterRunResult,
  type ProposalGitRunner,
} from "../../engine/proposal-git-committer";
export {
  createProposalOutcomeRecorder,
  type ProposalOutcomePayload,
  ProposalOutcomeRecorder,
  type ProposalOutcomeRecorderOptions,
  type ProposalOutcomeType,
} from "../../engine/proposal-outcome-recorder";
export {
  createRollbackInsightEmitter,
  type EmitAllOptions,
  ROLLBACK_CANDIDATE_TAG,
  RollbackInsightEmitter,
  type RollbackInsightEmitterOptions,
  rollbackInsightId,
} from "../../engine/rollback-insight-emitter";
export {
  collectRules,
  evaluateConditions,
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "../../engine/rule-engine";
export type { StateMachine } from "../../engine/state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  getAvailableTransitions,
  transition,
} from "../../engine/state-machine";
export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "../../engine/validation-engine";
export {
  type ValidatePhase3Options,
  validatePhase3,
} from "../../engine/validation-phase3";
