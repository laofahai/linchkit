/**
 * Engine type re-exports + pure-logic helpers (browser-safe).
 *
 * Class types are exported as type-only so consumers can use them for
 * annotations without pulling runtime code. Runtime engines live in
 * ../server/engines.ts.
 */

export type {
  ActionExecutor,
  ActionExecutorOptions,
  ActionRegistry,
  DataProvider,
  DataQueryOptions,
  ExecuteOptions,
  ExecutionChannel,
  PendingEvent,
  TransactionManager,
} from "../../engine/action-engine";
export type {
  ApprovalEngine,
  ApprovalEngineOptions,
  CreateApprovalOptions,
} from "../../engine/approval-engine";
export type {
  CommandBatchExecuteOptions,
  CommandContext,
  CommandExecuteOptions,
  CommandLayer,
  CommandLayerOptions,
  MiddlewareHandler,
  MiddlewareRegistration,
  SlotName,
} from "../../engine/command-layer";
// Pure-logic helpers (no server deps)
export {
  type ConditionContext,
  evaluateCondition,
  resolveField,
} from "../../engine/condition-evaluator";
// Field-lock semantics (Spec 63) — pure, browser-safe (engine/field-lock-checker
// imports only types). The runtime engine consumes these directly; exposing them
// here lets the auto-form UI reuse the authoritative matcher instead of mirroring it.
export {
  checkFieldLocks,
  type FieldLockCheckArgs,
  type FieldLockViolation,
  type FieldLockViolationType,
  matchesLockCondition,
  SYSTEM_FIELD_NAMES,
} from "../../engine/field-lock-checker";
export type {
  GeneratorOutcomeType,
  GeneratorPriorityAggregator,
  GeneratorPriorityAggregatorOptions,
  GeneratorPriorityConfig,
  GeneratorWeightRecord,
  OutcomeObservation,
} from "../../engine/generator-priority-aggregator";
// Interceptor type surface (Spec 63 Phase 3) — pure types, browser-safe.
// The runtime `createInterceptorRegistry` lives in ../server/engines.ts.
export type {
  FieldLockCheckContext,
  Interceptor,
  InterceptorCatalog,
  InterceptorPoint,
  InterceptorRegistration,
  InterceptorRegistry,
} from "../../engine/interceptors";
export {
  canAutoApproveOverlayChange,
  canAutoApproveOverlayProposal,
  executeOverlayProposal,
} from "../../engine/overlay-proposal-executor";
export type { PermissionRegistry } from "../../engine/permission-engine";

export type {
  EffectVerificationPayload,
  EffectVerificationRecord,
  EffectVerificationResult,
  ProposalEffectVerifier,
  ProposalEffectVerifierOptions,
  VerifiableSignalStore,
  VerifyAllOptions,
} from "../../engine/proposal-effect-verifier";
export type {
  CreateProposalOptions,
  OnApprovedHook,
  ProposalEngine,
  ProposalEngineOptions,
} from "../../engine/proposal-engine";
export type { ProposalFileWriterOptions } from "../../engine/proposal-file-writer";
export type { ProposalGeneratorDeps } from "../../engine/proposal-generator";
export type * from "../../engine/proposal-git-committer";
export type {
  ProposalOutcomePayload,
  ProposalOutcomeRecorder,
  ProposalOutcomeRecorderOptions,
  ProposalOutcomeType,
} from "../../engine/proposal-outcome-recorder";
export type {
  EmitAllOptions,
  RollbackInsightEmitter,
  RollbackInsightEmitterOptions,
} from "../../engine/rollback-insight-emitter";

export type {
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
} from "../../engine/rule-engine";
export type { StateMachine } from "../../engine/state-machine";
export type { ValidationContext } from "../../engine/validation-engine";
