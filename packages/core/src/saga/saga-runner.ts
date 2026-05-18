/**
 * Saga runner — pure, runtime-agnostic Saga executor (Spec 26 §1.2).
 *
 * Responsibilities:
 *   - Walk forward steps sequentially, recording outputs in shared context.
 *   - On any forward failure, replay compensations for completed steps in
 *     reverse order (Spec 26 §1.2 + §4: best-effort cleanup).
 *   - Surface execution state via `onStateChange` so a host can persist it.
 *   - Re-throw the ORIGINAL forward error after compensations finish; if any
 *     compensation also failed, wrap the message with the failure summary
 *     (mirrors `wrapWithCompensationFailures` in
 *     `addons/flow-restate/cap-flow-restate/src/flow-compiler.ts`).
 *
 * Out of scope (intentional, per task spec):
 *   - Durable execution / crash recovery — host responsibility. The runner
 *     emits state snapshots; a Restate wrapper, Postgres-backed scheduler,
 *     or in-memory test harness chooses how to persist them.
 *   - Restate-specific primitives — the runner takes a `runAction` callback,
 *     so it can be driven from any context (direct ActionExecutor call,
 *     Restate `ctx.run`, queue worker, test stub).
 *   - Database transactions — Spec 26 §4 explicitly mandates compensation
 *     for cross-action transactions; the runner never opens a SQL tx.
 *
 * Nested Sagas: a single step's `runAction` callback can itself drive a
 * Saga (the host passes a `SagaRunner` whose `runAction` invokes another
 * Saga's `run()`). The inner Saga reports its own compensation log; the
 * outer Saga only sees the step's success or failure result. This matches
 * Spec 26 §1.2: "a Saga can be one step inside a larger Saga".
 */

import type { SagaDefinition, SagaStepDefinition } from "./define-saga";
import type { SagaCompensationEntry, SagaExecutionState, SagaStepState } from "./saga-state";

// ── Callbacks ────────────────────────────────────────────

/**
 * Caller-supplied Action invoker. The runner never imports the Action
 * Engine directly — this keeps the Saga primitive runtime-agnostic and
 * trivially testable.
 *
 * `idempotencyKey` is set ONLY on compensation invocations (Spec 26 §3.2,
 * mirroring `flow-compiler.ts`). The host should forward it to the Action
 * Engine's `idempotencyKey` option so re-runs of the same compensation are
 * deduplicated.
 */
export type RunActionCallback = (
  actionName: string,
  input: Record<string, unknown>,
  options?: { idempotencyKey?: string },
) => Promise<unknown>;

/**
 * State-change notification. Invoked after every status transition so the
 * host can persist the snapshot. The runner clones the snapshot before
 * invoking the callback so handlers can safely retain references without
 * worrying about subsequent mutation.
 */
export type SagaStateListener = (state: SagaExecutionState) => void | Promise<void>;

// ── Runner options ───────────────────────────────────────

export interface SagaRunnerOptions {
  /** Saga definition to execute. */
  definition: SagaDefinition;
  /** Action invoker — see {@link RunActionCallback}. */
  runAction: RunActionCallback;
  /**
   * Caller-supplied run identifier. Used as the base for compensation
   * idempotency keys (`{runId}:{i}:{stepId}:compensate`) so the same run
   * being retried by an outer scheduler produces stable keys.
   */
  runId: string;
  /** Saga input snapshot, frozen at start time. */
  input?: Record<string, unknown>;
  /**
   * Optional reference to the parent Saga when this Saga is nested inside
   * another Saga's step. Recorded in the execution state for traceability.
   */
  parentSagaRunId?: string;
  parentStepId?: string;
  /** State-change listener — invoked after every transition. */
  onStateChange?: SagaStateListener;
}

// ── Runner ───────────────────────────────────────────────

export interface SagaRunner {
  /** Drive the Saga to completion. Resolves with the final state snapshot. */
  run(): Promise<SagaExecutionState>;
}

// ── Implementation ───────────────────────────────────────

/**
 * Deep-clone an arbitrary value. Wraps `structuredClone` (Bun supports it
 * natively) and falls back to the original reference for values that cannot
 * be structured-cloned (e.g. functions inside a payload). The runner only
 * stores plain JSON-shaped data in execution state, so the fallback path is
 * a defensive guard rather than an expected branch.
 */
function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Build a snapshot copy that is safe to hand to the listener. Uses
 * `structuredClone` for nested mutable payloads (`input`, per-step
 * `input`/`output`, `compensationLog` entries) so external handlers can
 * retain references AND freely mutate them without leaking back into the
 * runner's live state. Dates are preserved as Date instances so persistence
 * layers can still `JSON.stringify` them directly.
 */
function snapshotState(state: SagaExecutionState): SagaExecutionState {
  return {
    sagaName: state.sagaName,
    runId: state.runId,
    parentSagaRunId: state.parentSagaRunId,
    parentStepId: state.parentStepId,
    input: deepClone(state.input),
    status: state.status,
    steps: state.steps.map((s) => ({
      ...s,
      output: deepClone(s.output),
      startedAt: s.startedAt ? new Date(s.startedAt.getTime()) : undefined,
      finishedAt: s.finishedAt ? new Date(s.finishedAt.getTime()) : undefined,
    })),
    compensationLog: state.compensationLog.map((c) => ({
      ...c,
      executedAt: new Date(c.executedAt.getTime()),
    })),
    output: deepClone(state.output),
    error: state.error,
    startedAt: new Date(state.startedAt.getTime()),
    finishedAt: state.finishedAt ? new Date(state.finishedAt.getTime()) : undefined,
  };
}

/**
 * Resolve the compensation input for a step. Mirrors `flow-compiler.ts`:
 *   1. Explicit `compensationInput` on the definition wins.
 *   2. Otherwise, the forward step's output (when it's an object).
 *   3. Otherwise, an empty object.
 */
function resolveCompensationInput(
  step: SagaStepDefinition,
  stepOutput: unknown,
): Record<string, unknown> {
  if (step.compensationInput && typeof step.compensationInput === "object") {
    return step.compensationInput;
  }
  if (stepOutput && typeof stepOutput === "object") {
    return stepOutput as Record<string, unknown>;
  }
  return {};
}

/**
 * Format the final error message. When all compensations succeeded, the
 * original error is surfaced verbatim. When one or more compensations
 * failed, the message is extended with the failure summary so observers
 * see both the root cause AND the cleanup gaps. Identical contract to
 * `wrapWithCompensationFailures` in the Restate adapter.
 *
 * The wrapping path attaches `originalError` as the `cause` of the new
 * Error (ES2022 `Error` options bag, supported natively by Bun) so the
 * caller can still inspect the original subclass, stack, and custom
 * properties — e.g. `err.cause instanceof PaymentDeclined` keeps working.
 */
function formatFinalError(originalError: unknown, compensationLog: SagaCompensationEntry[]): Error {
  const originalMessage =
    originalError instanceof Error ? originalError.message : String(originalError);
  const failed = compensationLog.filter((entry) => entry.status === "failed");
  if (failed.length === 0) {
    return originalError instanceof Error ? originalError : new Error(originalMessage);
  }
  const failedSummary = failed
    .map((entry) => `${entry.stepId}->${entry.compensationAction}: ${entry.error ?? "unknown"}`)
    .join("; ");
  return new Error(`${originalMessage} (compensation failures: ${failedSummary})`, {
    cause: originalError,
  });
}

/**
 * Create a Saga runner. The returned runner can be executed once — running
 * a Saga twice requires a fresh runner because mutable state lives in the
 * closure (matches the "one run per runner instance" contract Restate uses
 * for workflows).
 */
export function createSagaRunner(options: SagaRunnerOptions): SagaRunner {
  const { definition, runAction, runId, onStateChange } = options;
  const input = options.input ?? {};
  const failurePolicy = definition.failurePolicy ?? "compensate";

  const state: SagaExecutionState = {
    sagaName: definition.name,
    runId,
    parentSagaRunId: options.parentSagaRunId,
    parentStepId: options.parentStepId,
    input,
    status: "pending",
    steps: definition.steps.map<SagaStepState>((s) => ({
      stepId: s.id,
      action: s.action,
      compensation: s.compensation,
      status: "pending",
    })),
    compensationLog: [],
    startedAt: new Date(),
  };

  async function notify(): Promise<void> {
    if (!onStateChange) return;
    await onStateChange(snapshotState(state));
  }

  async function compensate(originalError: unknown): Promise<void> {
    state.status = "compensating";
    await notify();

    // Walk completed steps in reverse order. A compensation failure is
    // logged but does NOT abort the remaining compensations — Spec 26 §4
    // mandates best-effort cleanup. The position index `i` is folded into
    // the idempotency key so a step that ran multiple times in a loop
    // would still get distinct keys per occurrence.
    let sawCompensationFailure = false;
    for (let i = definition.steps.length - 1; i >= 0; i--) {
      const stepDef = definition.steps[i];
      const stepState = state.steps[i];
      if (!stepDef || !stepState) continue;
      if (stepState.status !== "succeeded") continue;
      if (!stepDef.compensation) continue;

      stepState.status = "compensating";
      await notify();

      const compensationAction = stepDef.compensation;
      const compensationInput = resolveCompensationInput(stepDef, stepState.output);
      const idempotencyKey = `${runId}:${i}:${stepDef.id}:compensate`;

      const entry: SagaCompensationEntry = {
        stepId: stepDef.id,
        compensationAction,
        status: "succeeded",
        executedAt: new Date(),
      };

      try {
        await runAction(compensationAction, compensationInput, { idempotencyKey });
        stepState.status = "compensated";
      } catch (err) {
        entry.status = "failed";
        entry.error = err instanceof Error ? err.message : String(err);
        stepState.status = "compensation_failed";
        stepState.error = entry.error;
        sawCompensationFailure = true;
      }

      state.compensationLog.push(entry);
      await notify();
    }

    state.status = sawCompensationFailure ? "compensation_failed" : "compensated";
    state.error = originalError instanceof Error ? originalError.message : String(originalError);
    state.finishedAt = new Date();
    await notify();
  }

  async function runForward(): Promise<unknown> {
    state.status = "running";
    await notify();

    // Accumulated context fed into each forward step. Spec 26 §1.2 and the
    // doc-comment on `SagaStepDefinition.input` describe the shape:
    //   `{ ...sagaInput, [previousStepId1]: output1, ..., ...stepDef.input }`
    // i.e. the Saga's initial input acts as the base, each completed step
    // contributes its output keyed by step id, and the step's own static
    // `input` wins on key collision so callers can override.
    let lastOutput: unknown;
    for (let i = 0; i < definition.steps.length; i++) {
      const stepDef = definition.steps[i];
      const stepState = state.steps[i];
      if (!stepDef || !stepState) continue;

      stepState.status = "running";
      stepState.startedAt = new Date();
      await notify();

      // Build the per-invocation context fresh on each iteration — completed
      // step outputs are layered in by id, then the step's static input.
      const context: Record<string, unknown> = { ...input };
      for (let j = 0; j < i; j++) {
        const priorDef = definition.steps[j];
        const priorState = state.steps[j];
        if (!priorDef || !priorState) continue;
        if (priorState.status !== "succeeded") continue;
        context[priorDef.id] = priorState.output;
      }
      const stepInput: Record<string, unknown> = { ...context, ...(stepDef.input ?? {}) };

      try {
        const output = await runAction(stepDef.action, stepInput);
        stepState.status = "succeeded";
        stepState.output = output;
        stepState.finishedAt = new Date();
        lastOutput = output;
        await notify();
      } catch (err) {
        stepState.status = "failed";
        stepState.error = err instanceof Error ? err.message : String(err);
        stepState.finishedAt = new Date();
        await notify();
        throw err;
      }
    }

    return lastOutput;
  }

  async function run(): Promise<SagaExecutionState> {
    try {
      const output = await runForward();
      state.status = "succeeded";
      state.output = output;
      state.finishedAt = new Date();
      await notify();
      return snapshotState(state);
    } catch (err) {
      if (failurePolicy === "compensate") {
        await compensate(err);
        throw formatFinalError(err, state.compensationLog);
      }
      // fail_fast — record the failure and propagate the original error
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.finishedAt = new Date();
      await notify();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return { run };
}

/**
 * Convenience helper for the common case: build and immediately run a Saga.
 * The promise resolves with the final state on success, and rejects with
 * the original error (or compensation-wrapped error) on failure.
 *
 * On rejection the caller can still observe the full execution state via
 * `onStateChange` snapshots — the runner notifies the listener BEFORE
 * re-throwing.
 */
export async function runSaga(options: SagaRunnerOptions): Promise<SagaExecutionState> {
  return createSagaRunner(options).run();
}
