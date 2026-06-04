/**
 * Action-execution rule evaluation (Spec 23 §1.1)
 *
 * Extracted from `action-engine.ts` Step 4c so the rule-evaluation /
 * approval-suspension decision is a single, unit-testable unit instead of an
 * inline block inside the ~2k-line executor (issue #462). The executor keeps
 * ownership of the side effects this decision implies (execution logging,
 * approval-request creation, early returns) — this helper is a PURE decision:
 * it reads the current record (for record-state conditions), evaluates the
 * pre-collected rule set, and reports what the executor should do next.
 *
 * Keeping it side-effect-free (no logging, no approval engine, no return-shape
 * coupling) is also what makes the planned in-transaction relocation tractable:
 * the executor can call this with the transactional provider from inside the
 * write transaction without dragging logging/approval wiring into the tx.
 */

import type { MetricsCollector } from "../observability/metrics";
import type { Actor } from "../types/action";
import type { ExecutionMeta } from "../types/execution-meta";
import type {
  ExecuteActionEffect,
  RequireApprovalEffect,
  RuleDefinition,
  TriggerFlowEffect,
} from "../types/rule";
// Type-only import — erased at runtime, so this does NOT create a runtime cycle
// with action-engine.ts (which imports `evaluateActionRules` as a value).
import type { DataProvider, DataQueryOptions } from "./action-engine";
import { evaluateRules } from "./rule-engine";

/** Inputs for {@link evaluateActionRules}. */
export interface EvaluateActionRulesArgs {
  /**
   * Rules already filtered to this action AND priority-sorted (the output of
   * `collectRules`). MUST be non-empty — callers short-circuit on an empty set
   * before reaching here, so this helper never pays the read/eval cost for an
   * action with no applicable rules.
   */
  applicableRules: RuleDefinition[];
  /**
   * Entity the action targets. Gates the record-state read: when undefined (a
   * non-entity action), conditions evaluate against the input only.
   */
  entity: string | undefined;
  /**
   * Validated (and, in strict mode, sanitized) action input. Record-state
   * conditions see the current record merged UNDER this, so input values win
   * over stored ones.
   */
  effectiveInput: Record<string, unknown>;
  actor: Actor;
  meta: ExecutionMeta;
  /**
   * Provider used to read the current record for record-state conditions. The
   * executor passes the parent's transactional provider for a nested action
   * (so the rule sees the parent's uncommitted writes) and the tenant-scoped
   * base provider otherwise.
   */
  readProvider: DataProvider;
  queryOptions?: DataQueryOptions;
  /** Rule names to skip — set on re-execution after an approval is granted. */
  skipRules?: string[];
  metrics: MetricsCollector;
}

/** What the executor should do after rule evaluation. */
export interface ActionRuleEvalDecision {
  /**
   * Non-null when a `block` effect fired. The executor logs a `blocked`
   * execution and returns a failure result; no write happens.
   */
  blocked: { reason: string; suggestion: string } | null;
  /**
   * Non-null when a `require_approval` effect fired. The executor suspends the
   * action into an approval request IF an approval engine is wired; with no
   * engine it proceeds (the gate is best-effort, not a silent hard block).
   * `triggerRules` are the rule names to `skipRules` on the post-approval
   * re-execution so the approval rule does not re-fire.
   */
  requiredApproval: { effect: RequireApprovalEffect; triggerRules: string[] } | null;
  /**
   * Record id resolved from the input (non-empty string), or undefined for a
   * create / id-less action. Used for the approval request and logging.
   */
  recordId: string | undefined;
  /**
   * Input with any `enrich` setFields merged in. Identical to the supplied
   * `effectiveInput` when no enrich fired. The executor adopts this as the
   * payload reaching the handler / declarative write so enrich applies to both.
   */
  effectiveInput: Record<string, unknown>;
  /** Messages from `warn` effects, surfaced on the action result. */
  warnings: string[];
  /** `execute_action` effects to run post-commit (once the write is durable). */
  pendingActions: ExecuteActionEffect[];
  /** `trigger_flow` effects to run post-commit (once the write is durable). */
  pendingFlows: TriggerFlowEffect[];
}

/**
 * Evaluate the action-triggered business rules for a single execution.
 *
 * Reads the current record (for an update whose input carries an `id`) so
 * record-state conditions can reference stored field values, evaluates the
 * pre-collected + priority-sorted rule set, and folds the resulting effects
 * into a {@link ActionRuleEvalDecision}.
 *
 * Effect precedence mirrors the previous inline logic exactly:
 *  - `block` short-circuits (the executor aborts before any write); the
 *    returned `effectiveInput`/`warnings`/pending arrays are empty.
 *  - `require_approval` is reported but NOT applied here — the executor decides
 *    whether to suspend based on whether an approval engine is wired. When it
 *    suspends it ignores the enrich/warn/pending payload (the action is
 *    suspended, not run); when no engine is wired it proceeds and applies them.
 *  - `enrich` / `warn` / `execute_action` / `trigger_flow` are folded into the
 *    decision for the executor to apply on the proceed path.
 */
export async function evaluateActionRules(
  args: EvaluateActionRulesArgs,
): Promise<ActionRuleEvalDecision> {
  const { applicableRules, entity, actor, meta, readProvider, queryOptions, skipRules, metrics } =
    args;
  let effectiveInput = args.effectiveInput;

  const recordIdRaw = effectiveInput.id;
  const recordId =
    typeof recordIdRaw === "string" && recordIdRaw.length > 0 ? recordIdRaw : undefined;

  // Record-state context: for an update (input carries an id), read the current
  // record so conditions can reference existing field values. A read failure
  // (not found / access) degrades to input-only evaluation.
  let ruleTarget: Record<string, unknown> = effectiveInput;
  if (entity && recordId) {
    try {
      const existing = await readProvider.get(entity, recordId, queryOptions);
      if (existing) ruleTarget = { ...existing, ...effectiveInput };
    } catch {
      // Not readable — fall back to input-only evaluation.
    }
  }

  const ruleOutput = await evaluateRules(
    applicableRules,
    {
      target: ruleTarget,
      actor: { type: actor.type, id: actor.id, groups: actor.groups ?? [] },
      meta,
    },
    { skipRules, metrics },
  );

  // `block` short-circuits: abort before any write, nothing else to apply.
  if (ruleOutput.blocked) {
    const reason = ruleOutput.blockReasons.join("; ") || "Blocked by rule";
    return {
      blocked: { reason, suggestion: ruleOutput.contexts[0]?.suggestion ?? reason },
      requiredApproval: null,
      recordId,
      effectiveInput,
      warnings: [],
      pendingActions: [],
      pendingFlows: [],
    };
  }

  let requiredApproval: ActionRuleEvalDecision["requiredApproval"] = null;
  if (ruleOutput.requiredApproval) {
    const triggerRules = ruleOutput.results
      .filter((r) => r.triggered && r.effect?.type === "require_approval")
      .map((r) => r.rule);
    requiredApproval = { effect: ruleOutput.requiredApproval, triggerRules };
  }

  if (Object.keys(ruleOutput.enrichFields).length > 0) {
    effectiveInput = { ...effectiveInput, ...ruleOutput.enrichFields };
  }

  return {
    blocked: null,
    requiredApproval,
    recordId,
    effectiveInput,
    warnings: ruleOutput.warnings.map((w) => w.message),
    pendingActions: [...ruleOutput.actions],
    pendingFlows: [...ruleOutput.flows],
  };
}
