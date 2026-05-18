/**
 * Saga module — declarative Saga composition with compensation (Spec 26 §1.2).
 *
 * See `define-saga.ts` for the declaration entry point, `saga-runner.ts`
 * for the runtime-agnostic executor, and `saga-state.ts` for serializable
 * state types.
 */

export {
  defineSaga,
  type SagaDefinition,
  type SagaFailurePolicy,
  type SagaStepDefinition,
  validateSagaDefinition,
} from "./define-saga";
export {
  createSagaRunner,
  type RunActionCallback,
  runSaga,
  type SagaRunner,
  type SagaRunnerOptions,
  type SagaStateListener,
} from "./saga-runner";
export type {
  SagaCompensationEntry,
  SagaExecutionState,
  SagaStatus,
  SagaStepState,
  SagaStepStatus,
} from "./saga-state";
