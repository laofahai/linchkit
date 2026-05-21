/**
 * Engine module — runtime engines for core abstractions.
 *
 * Local business engines only. Sibling directories (ai, event, flow,
 * observability, schema) are exported separately via server-entry.ts.
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
// Batch action engine (Spec 04 §8, Spec 16 §2.1)
export {
  BatchValidationError,
  type ExecuteBatchOptions,
  executeBatch,
  MAX_BATCH_SIZE,
} from "./batch-action-engine";
// Command layer
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
} from "./command-layer";
// Condition evaluator
export { type ConditionContext, evaluateCondition, resolveField } from "./condition-evaluator";
// Field-lock checker (Spec 63)
export {
  checkFieldLocks,
  type FieldLockCheckArgs,
  type FieldLockViolation,
  type FieldLockViolationType,
  matchesLockCondition,
} from "./field-lock-checker";
// Onchange evaluator (Spec 64)
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
} from "./onchange-evaluator";
// Overlay proposal executor
export {
  canAutoApproveOverlayChange,
  canAutoApproveOverlayProposal,
  executeOverlayProposal,
} from "./overlay-proposal-executor";
// Permission engine
export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./permission-engine";
// Proposal effect verifier (Spec 55 §7.7 Phase 2)
export {
  createProposalEffectVerifier,
  type EffectVerificationResult,
  type EffectVerificationStatus,
  ProposalEffectVerifier,
  type ProposalEffectVerifierOptions,
} from "./proposal-effect-verifier";
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
  ProposalGenerationError,
  type ProposalGeneratorDeps,
} from "./proposal-generator";
// Proposal git committer (Spec 55 §7.7)
export {
  createProposalGitCommitter,
  type ProposalGhRunner,
  type ProposalGitCommitResult,
  ProposalGitCommitter,
  type ProposalGitCommitterOptions,
  type ProposalGitCommitterRunResult,
  type ProposalGitRunner,
} from "./proposal-git-committer";
// Proposal outcome recorder (Spec 55 §7.7 Phase 1)
export {
  createProposalOutcomeRecorder,
  type ProposalOutcomePayload,
  ProposalOutcomeRecorder,
  type ProposalOutcomeRecorderOptions,
  type ProposalOutcomeType,
  type RecordProposalOutcomeOptions,
} from "./proposal-outcome-recorder";
// Rule engine
export {
  collectRules,
  evaluateConditions,
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
  getAvailableTransitions,
  transition,
} from "./state-machine";
// Validation engine
export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./validation-engine";
