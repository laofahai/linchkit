/**
 * Post-commit rule side effects (Spec 23 §1.1 / Spec 26 §2.2).
 *
 * The pre-write decision (see {@link evaluateActionRules} in
 * `action-rule-eval.ts`) collects `execute_action` / `trigger_flow` effects but
 * does NOT run them — they are deferred to this point so they only fire once the
 * triggering action's write is durable (eventual consistency). This runner is
 * best-effort: a failure here is logged and never fails the already-committed
 * action. Only the root / non-transactional execution level calls it; a nested
 * action inside a parent transaction bubbles its collected effects up so they
 * run on the PARENT's commit instead.
 */

import type { ActionResult, Actor } from "../types/action";
import type { ExecutionMeta } from "../types/execution-meta";
import { extendExecutionMeta } from "../types/execution-meta";
import type { Logger } from "../types/logger";
import type { ExecuteActionEffect, TriggerFlowEffect } from "../types/rule";
import type { ActionFlowStarter, ExecuteOptions } from "./action-engine-types";

/** The executor's own `execute` method, threaded in so an `execute_action`
 *  effect re-invokes through the same executor (depth-bounded). */
type ActionExecuteFn = (
  actionName: string,
  input: Record<string, unknown>,
  actor: Actor,
  options?: ExecuteOptions,
) => Promise<ActionResult>;

export interface PostCommitRuleEffectsArgs {
  /** `execute_action` effects collected by the rule evaluation, in order. */
  pendingActions: ExecuteActionEffect[];
  /** `trigger_flow` effects collected by the rule evaluation, in order. */
  pendingFlows: TriggerFlowEffect[];
  /** The executor's `execute` method (re-invokes child actions). */
  execute: ActionExecuteFn;
  /** Flow engine for `trigger_flow`; when undefined, flows are logged + skipped. */
  flowEngine: ActionFlowStarter | undefined;
  logger: Logger;
  /** Name of the action whose rules produced these effects (for provenance + logs). */
  actionName: string;
  actor: Actor;
  /** The (enriched) input of the triggering action — the default child input. */
  effectiveInput: Record<string, unknown>;
  /** The triggering action's resolved meta — extended with child provenance. */
  resolvedMeta: ExecutionMeta;
  /** The triggering action's recursion depth (child runs at depth + 1). */
  currentDepth: number;
  /** Tenant of the triggering action, forwarded to child actions / flows. */
  tenantId: string | undefined;
}

/**
 * Run the post-commit `execute_action` / `trigger_flow` side effects collected
 * during rule evaluation. Best-effort: each effect's failure is logged and
 * swallowed so it never fails the already-committed triggering action.
 */
export async function runPostCommitRuleEffects(args: PostCommitRuleEffectsArgs): Promise<void> {
  const {
    pendingActions,
    pendingFlows,
    execute,
    flowEngine,
    logger,
    actionName,
    actor,
    effectiveInput,
    resolvedMeta,
    currentDepth,
    tenantId,
  } = args;

  for (const act of pendingActions) {
    try {
      // Stamp provenance like ctx.execute: `_source_action` (caller) +
      // `_depth` in meta, plus `_depth` as an ExecuteOptions field so the
      // recursion-depth guard bounds an execute_action cycle.
      const childMeta = extendExecutionMeta(
        resolvedMeta,
        {},
        { _depth: currentDepth + 1, _source_action: actionName },
      );
      const result = await execute(act.action, act.params ?? effectiveInput, actor, {
        tenantId,
        meta: childMeta,
        _depth: currentDepth + 1,
      });
      if (!result.success) {
        const data = result.data as { error?: unknown } | undefined;
        logger.warn(
          `[rule:execute_action] "${act.action}" triggered by a rule on "${actionName}" did not succeed: ${typeof data?.error === "string" ? data.error : "unknown error"}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[rule:execute_action] "${act.action}" triggered by a rule on "${actionName}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const fl of pendingFlows) {
    if (!flowEngine) {
      logger.warn(
        `[rule:trigger_flow] no flow engine wired — skipping flow "${fl.flow}" triggered by a rule on "${actionName}".`,
      );
      continue;
    }
    try {
      await flowEngine.startFlow(fl.flow, fl.input ?? effectiveInput, {
        tenantId,
        actor,
      });
    } catch (err) {
      logger.warn(
        `[rule:trigger_flow] starting flow "${fl.flow}" triggered by a rule on "${actionName}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
