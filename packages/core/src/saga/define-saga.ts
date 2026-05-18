/**
 * defineSaga — declarative Saga definition (Spec 26 §1.2).
 *
 * A Saga composes multiple Actions into a logical "long-running transaction"
 * by pairing each forward step with a compensating Action. When a forward
 * step fails, the Saga runner replays the compensations for already-executed
 * steps in reverse order (best-effort cleanup).
 *
 * Saga is intentionally distinct from `defineFlow`:
 *   - Flow is the full workflow language (branching, approval gates, AI
 *     steps, parallel execution, durable Restate execution).
 *   - Saga is a focused primitive for compensation orchestration that the
 *     core runtime can execute without any third-party engine.
 *
 * Spec 26 §1.2 declares Flow as the primary surface for Saga in user code.
 * `defineSaga` is the in-core seam used by:
 *   - Restate adapter (`cap-flow-restate`) when desugaring `FlowDefinition`
 *     into compensation iterators
 *   - Unit tests that need to exercise compensation logic without standing
 *     up a Restate workflow
 *   - Hosts that want to drive Sagas directly from their own scheduler.
 */

// ── Step definition ──────────────────────────────────────

/**
 * A single forward step of a Saga.
 *
 * `compensationInput` is optional; when omitted the runner falls back to
 * the forward step's output, matching the Restate adapter convention
 * (`flow-compiler.ts`).
 *
 * `compensation` is also optional. Spec 26 §4 frames compensation as
 * best-effort — some forward steps simply have no inverse (e.g. an
 * external email send). Such steps still participate in the forward chain
 * but are skipped during rollback.
 */
export interface SagaStepDefinition {
  /** Unique step identifier within the Saga. */
  id: string;
  /** Forward Action name to invoke. */
  action: string;
  /**
   * Static input passed to the forward Action. The runner shallow-merges
   * this with the Saga's accumulated context (previous step outputs keyed
   * by step id) before invocation; the resolution rules belong to the host
   * `runAction` callback — the runner just forwards what's provided.
   */
  input?: Record<string, unknown>;
  /** Compensation Action name; omitted when no inverse exists. */
  compensation?: string;
  /**
   * Static input for the compensation Action. When omitted the runner uses
   * the forward step's output, mirroring `flow-compiler.ts`.
   */
  compensationInput?: Record<string, unknown>;
}

// ── Saga definition ──────────────────────────────────────

/**
 * Failure policy mirrors Spec 26 §1.2 wording so callers can use the same
 * vocabulary they already know from `FlowDefinition.failurePolicy`.
 *
 *   - `compensate` (default) — on any forward failure, replay compensations
 *     for completed steps in reverse order.
 *   - `fail_fast` — propagate the original error without compensation.
 *     Used when a Saga is wrapped by an outer rollback mechanism (e.g. a
 *     parent Saga that owns the compensation).
 */
export type SagaFailurePolicy = "compensate" | "fail_fast";

/** Complete Saga definition. */
export interface SagaDefinition {
  /** Unique Saga name. */
  name: string;
  /** Human-readable label. */
  label?: string;
  /** Optional description. */
  description?: string;
  /** Ordered list of steps. */
  steps: SagaStepDefinition[];
  /** Failure handling strategy (default: `compensate`). */
  failurePolicy?: SagaFailurePolicy;
}

// ── Public entry point ──────────────────────────────────

/**
 * Declare a Saga. Currently a pass-through (matches the `defineXxx` pattern
 * in `define.ts`); the runtime registry and metadata helpers live alongside
 * the runner so the data structure stays inert at definition time.
 *
 * Throws synchronously on a malformed definition — duplicate step ids are
 * a programming error that should fail at boot, not silently during a
 * compensation cascade where the duplicate would shadow distinct undo
 * intents.
 */
export function defineSaga(definition: SagaDefinition): SagaDefinition {
  validateSagaDefinition(definition);
  return definition;
}

/**
 * Internal validation. Exported for tests; not re-exported from the public
 * entry point.
 */
export function validateSagaDefinition(definition: SagaDefinition): void {
  if (!definition.name) {
    throw new Error("Saga definition requires a non-empty name");
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new Error(`Saga "${definition.name}" requires at least one step`);
  }
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!step.id) {
      throw new Error(`Saga "${definition.name}" has a step with no id`);
    }
    if (!step.action) {
      throw new Error(`Saga "${definition.name}" step "${step.id}" has no action declared`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Saga "${definition.name}" has duplicate step id "${step.id}"`);
    }
    seen.add(step.id);
  }
}
