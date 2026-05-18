/**
 * Saga execution state (Spec 26 §1.2 — cross-action transactions).
 *
 * These types describe the runtime state of a Saga execution. They are
 * intentionally serializable (plain JSON shapes — no class instances, no
 * function references) so callers can persist Saga state to any store
 * (Postgres, KV, JSON file, in-memory snapshot) without a custom codec.
 *
 * Persistence itself is OUT of scope for the core Saga runtime — the runner
 * exposes `onStateChange` callbacks so a host can snapshot state on every
 * transition. The Restate adapter (`cap-flow-restate`) provides durable
 * execution; the in-process Saga runner is a runtime-agnostic primitive used
 * by tests, demos, and any host that doesn't need Restate's guarantees.
 */

// ── Step-level state ─────────────────────────────────────

/** Lifecycle of a single forward step within a Saga. */
export type SagaStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "compensating"
  | "compensated"
  | "compensation_failed";

/**
 * Per-step bookkeeping. One entry exists per declared step regardless of
 * whether the step ever ran — callers can reason about progress by inspecting
 * `status`.
 *
 * `output` is captured for steps that succeeded so it can be fed into the
 * matching compensation when no explicit `compensationInput` is declared
 * (mirrors the Restate adapter behaviour — see `flow-compiler.ts`).
 */
export interface SagaStepState {
  /** Step identifier (matches `SagaStepDefinition.id`). */
  stepId: string;
  /** Forward Action invoked for this step. */
  action: string;
  /** Compensating Action declared for this step (if any). */
  compensation?: string;
  /** Current lifecycle of the step. */
  status: SagaStepStatus;
  /** Output captured when the forward Action succeeded. */
  output?: unknown;
  /** Error message captured when the forward or compensation step failed. */
  error?: string;
  /** When the forward step started. */
  startedAt?: Date;
  /** When the forward step finished (success or failure). */
  finishedAt?: Date;
}

// ── Compensation log ─────────────────────────────────────

/**
 * Result of a single compensation action invocation. Mirrors
 * `CompensationLogEntry` in `types/flow.ts` so the Restate adapter and the
 * core runner produce identical log shapes — a host can persist either one
 * with the same code path.
 */
export interface SagaCompensationEntry {
  /** Step ID whose compensation was executed. */
  stepId: string;
  /** Compensation Action name. */
  compensationAction: string;
  /** Whether the compensation succeeded. */
  status: "succeeded" | "failed";
  /** Error message when the compensation failed. */
  error?: string;
  /** When the compensation finished. */
  executedAt: Date;
}

// ── Saga-level state ─────────────────────────────────────

/** Lifecycle of the Saga as a whole. */
export type SagaStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "compensating"
  | "compensated"
  | "compensation_failed";

/**
 * Top-level Saga execution snapshot. A host that wants crash-safe Sagas
 * should persist this object on every `onStateChange` notification and
 * re-create the runner from the persisted snapshot on restart.
 *
 * `parentSagaRunId` lets nested Sagas (Spec 26 §1.2 — "a Saga can be one
 * step inside a larger Saga") trace back to their orchestrating parent.
 */
export interface SagaExecutionState {
  /** Saga definition name. */
  sagaName: string;
  /** Unique execution identifier (caller-supplied or generated). */
  runId: string;
  /** Optional reference to the parent Saga run when this Saga is nested. */
  parentSagaRunId?: string;
  /** Optional reference to the parent step ID when this Saga is nested. */
  parentStepId?: string;
  /** Saga input snapshot, frozen at start time. */
  input: Record<string, unknown>;
  /** Overall Saga lifecycle. */
  status: SagaStatus;
  /** Per-step bookkeeping (one entry per declared step). */
  steps: SagaStepState[];
  /** Compensation invocations recorded during rollback. */
  compensationLog: SagaCompensationEntry[];
  /** Final result captured after a successful run. */
  output?: unknown;
  /** Root cause when the Saga failed (the original forward-step error). */
  error?: string;
  /** When the Saga started. */
  startedAt: Date;
  /** When the Saga finished (success, failure, or compensated). */
  finishedAt?: Date;
}
