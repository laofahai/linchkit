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
export {
  canAutoApproveOverlayChange,
  canAutoApproveOverlayProposal,
  executeOverlayProposal,
} from "../../engine/overlay-proposal-executor";
export type { PermissionRegistry } from "../../engine/permission-engine";
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
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
} from "../../engine/rule-engine";
export type { StateMachine } from "../../engine/state-machine";
export type { ValidationContext } from "../../engine/validation-engine";
