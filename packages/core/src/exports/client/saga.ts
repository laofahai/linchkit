/**
 * Saga — declarative composition with compensation (Spec 26 §1.2). Browser-safe.
 */

export {
  createSagaRunner,
  defineSaga,
  type RunActionCallback,
  runSaga,
  type SagaCompensationEntry,
  type SagaDefinition,
  type SagaExecutionState,
  type SagaFailurePolicy,
  type SagaRunner,
  type SagaRunnerOptions,
  type SagaStateListener,
  type SagaStatus,
  type SagaStepDefinition,
  type SagaStepState,
  type SagaStepStatus,
} from "../../saga";
