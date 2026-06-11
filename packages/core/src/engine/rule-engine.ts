/**
 * Rule evaluation engine
 *
 * Evaluates multiple RuleDefinitions against a context, handling:
 * - Priority ordering (descending)
 * - Short-circuiting on block effects
 * - Effect merging across all triggered rules
 *
 * Two-phase API for batch optimization (Spec 04 §8.2, issue #209):
 *  - {@link collectRules}: pure rule-set resolution by `trigger.action`.
 *    Stable for the entire batch — call ONCE per action name.
 *  - {@link evaluateConditions}: per-record condition evaluation against
 *    a pre-collected rule set. Call once per record.
 *
 * {@link evaluateRules} remains as the simple per-record entry point that
 * accepts an already-filtered rule list (back-compat).
 */

import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import type { ErrorContext } from "../types/error";
import type { ExecutionMeta } from "../types/execution-meta";
import type {
  BlockEffect,
  CodeCondition,
  DeclarativeCondition,
  EnrichEffect,
  ExecuteActionEffect,
  RequireApprovalEffect,
  RuleDefinition,
  RuleEffect,
  RuleEvaluationResult,
  TriggerFlowEffect,
  WarnEffect,
} from "../types/rule";
import { type ConditionContext, evaluateCondition } from "./condition-evaluator";

// ── Helpers ─────────────────────────────────────────

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Assign properties from source to target, filtering out prototype-polluting keys. */
function safeAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (!DANGEROUS_KEYS.has(key)) {
      target[key] = source[key];
    }
  }
}

// ── Timeout helper ──────────────────────────────────

/** Race a promise against a timeout. Rejects with a descriptive error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Rule condition "${label}" timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── Input / Output types ────────────────────────────

export interface RuleEvalOptions {
  /** Timeout in ms for async code conditions. No timeout if omitted. */
  timeout?: number;
  /** Rule names to skip (e.g., rules that triggered an approval that has been granted) */
  skipRules?: string[];
  /** Metrics collector — optional, defaults to noopMetricsCollector (zero overhead) */
  metrics?: MetricsCollector;
}

export interface RuleEvalInput {
  target: Record<string, unknown>;
  actor: { type: string; id: string; groups: string[] };
  context?: Record<string, unknown>;
  /** Current execution meta — resolves `meta.*` field paths in conditions (Spec 65 §6). */
  meta?: ExecutionMeta;
  /**
   * The PERSISTED record backing `target` (which merges caller input over it,
   * input winning). Guard rules read trustworthy stored values from here —
   * via `ctx.record` in code conditions or `record.*` paths in declarative
   * ones. Undefined when no stored row exists.
   */
  record?: Record<string, unknown>;
}

export interface RuleEvalOutput {
  /** Whether any rule was triggered */
  triggered: boolean;
  /** Whether the action is blocked */
  blocked: boolean;
  /** Block reasons (from all block effects) */
  blockReasons: string[];
  /** Highest approval level required, or null */
  requiredApproval: RequireApprovalEffect | null;
  /** All warning messages */
  warnings: WarnEffect[];
  /** Merged enrichment fields */
  enrichFields: Record<string, unknown>;
  /** Collected execute_action effects */
  actions: ExecuteActionEffect[];
  /** Collected trigger_flow effects (run post-commit) */
  flows: TriggerFlowEffect[];
  /** Per-rule evaluation details */
  results: RuleEvaluationResult[];
  /** Total evaluation duration in ms */
  duration: number;
  /** AI-friendly error contexts for block/warn effects (Spec 60 §3.4) */
  contexts: ErrorContext[];
}

/**
 * Resolve the rule set for an action name.
 *
 * Pure-function filter: returns rules whose `trigger.action` matches
 * `actionName` (string equality, or membership when the trigger lists
 * multiple action names). Independent of the record under evaluation,
 * so the result is STABLE for the entire batch — callers should hoist
 * this call OUT of any per-record loop.
 *
 * Non-action triggers (state-change, field-change, event, schedule) are
 * filtered out; they don't apply to the action-execution path.
 *
 * Spec 04 §8.2 batch-mode rule-evaluation merging (issue #209): a
 * 100-item batch with N rules calls `collectRules` once, not 100×.
 */
export function collectRules(actionName: string, rules: RuleDefinition[]): RuleDefinition[] {
  const matched: RuleDefinition[] = [];
  for (const rule of rules) {
    const trigger = rule.trigger as { action?: string | string[] };
    const actions = trigger.action;
    if (actions === undefined) continue;
    if (typeof actions === "string") {
      if (actions === actionName) matched.push(rule);
    } else if (Array.isArray(actions) && actions.includes(actionName)) {
      matched.push(rule);
    }
  }
  // Pre-sort by priority descending so the per-record evaluator never has
  // to reorder the same rule set across a batch (codex P2 review on
  // PR #288). Default priority is 0; ties preserve declaration order
  // because Array#sort in V8 / JSC is stable.
  matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return matched;
}

/**
 * Evaluate a pre-collected rule set against a single record/context.
 *
 * Rules are sorted by priority (descending). Block effects cause
 * short-circuiting: once a block is encountered, remaining rules
 * are skipped but all block reasons so far are collected.
 *
 * Empty rule list short-circuits: returns a no-op result without
 * touching any per-record condition logic.
 *
 * This is the per-record path of the two-phase API (Spec 04 §8.2,
 * issue #209). For batch execution, call {@link collectRules} once
 * per batch and pass the result here for every item.
 */
export async function evaluateConditions(
  rules: RuleDefinition[],
  input: RuleEvalInput,
  options?: RuleEvalOptions,
): Promise<RuleEvalOutput> {
  const totalStart = performance.now();

  const output: RuleEvalOutput = {
    triggered: false,
    blocked: false,
    blockReasons: [],
    requiredApproval: null,
    warnings: [],
    enrichFields: {},
    actions: [],
    flows: [],
    results: [],
    duration: 0,
    contexts: [],
  };

  const metrics = options?.metrics ?? noopMetricsCollector;

  if (rules.length === 0) {
    output.duration = performance.now() - totalStart;
    return output;
  }

  // Rules are pre-sorted by priority (descending) inside `collectRules` —
  // we iterate them as-is to avoid reordering the same set N times across
  // a batch (codex P2 review on PR #288). Callers building a rules array
  // by hand for the back-compat `evaluateRules` entry point get the sort
  // for free via the wrapper below.

  const ctx: ConditionContext = {
    target: input.target,
    context: input.context ?? {},
    actor: input.actor,
    meta: input.meta,
    record: input.record,
  };

  for (const rule of rules) {
    // Skip rules that have already been approved
    if (options?.skipRules?.includes(rule.name)) {
      output.results.push({
        rule: rule.name,
        triggered: false,
        effect: null,
        duration: 0,
        skipped: true,
      });
      continue;
    }

    const ruleStart = performance.now();

    let triggered: boolean;
    let error: string | undefined;

    try {
      if (typeof rule.condition === "function") {
        const controller = options?.timeout ? new AbortController() : undefined;
        const result = (rule.condition as CodeCondition)({
          target: ctx.target,
          context: ctx.context,
          actor: ctx.actor,
          meta: ctx.meta,
          record: ctx.record,
          signal: controller?.signal,
        });

        if (options?.timeout && result instanceof Promise) {
          triggered = await withTimeout(result, options.timeout, rule.name).finally(() =>
            controller?.abort(),
          );
        } else {
          triggered = await result;
        }
      } else {
        triggered = evaluateCondition(rule.condition as DeclarativeCondition, ctx);
      }
    } catch (err) {
      // Fail-closed: treat as triggered so block rules still block on error
      triggered = true;
      error = err instanceof Error ? err.message : String(err);
    }

    const duration = performance.now() - ruleStart;

    const result: RuleEvaluationResult = {
      rule: rule.name,
      triggered,
      effect: triggered ? rule.effect : null,
      duration,
      ...(error !== undefined && { error }),
    };
    output.results.push(result);

    metrics.increment("rule.evaluated", {
      rule: rule.name,
      effect: triggered ? rule.effect.type : "none",
    });
    metrics.timing("rule.evaluation_duration_ms", duration, {
      rule: rule.name,
    });

    if (!triggered) continue;

    output.triggered = true;
    mergeEffect(output, rule.effect, rule.name);

    // Track block events separately for alert/dashboard convenience
    if (rule.effect.type === "block") {
      metrics.increment("rule.block_count", { rule: rule.name });
      break;
    }
  }

  output.duration = performance.now() - totalStart;
  return output;
}

/**
 * Per-record rule evaluation against a hand-filtered rule list.
 *
 * Back-compat entry point: existing callers that pass an UNSORTED rule
 * array still get priority-descending evaluation. The wrapper sorts
 * once before delegating to {@link evaluateConditions}.
 *
 * New batch callers should split the work via {@link collectRules}
 * (which sorts) + {@link evaluateConditions} (which assumes sorted
 * input) so the rule-set resolution AND ordering run once per batch
 * instead of once per record (Spec 04 §8.2, issue #209).
 */
export async function evaluateRules(
  rules: RuleDefinition[],
  input: RuleEvalInput,
  options?: RuleEvalOptions,
): Promise<RuleEvalOutput> {
  if (rules.length <= 1) return evaluateConditions(rules, input, options);
  const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return evaluateConditions(sorted, input, options);
}

/**
 * Merge a single effect into the cumulative output.
 */
function mergeEffect(output: RuleEvalOutput, effect: RuleEffect, ruleName?: string): void {
  switch (effect.type) {
    case "block": {
      const block = effect as BlockEffect;
      output.blocked = true;
      output.blockReasons.push(block.reason ?? block.message);
      output.contexts.push({
        constraint: ruleName,
        expected: block.reason ?? block.message,
        suggestion: `Rule "${ruleName ?? "unknown"}" blocked this action: ${block.reason ?? block.message}`,
      });
      break;
    }
    case "warn": {
      const warn = effect as WarnEffect;
      output.warnings.push(warn);
      output.contexts.push({
        constraint: ruleName,
        suggestion: `Warning from rule "${ruleName ?? "unknown"}": ${warn.message}`,
      });
      break;
    }
    case "require_approval": {
      const approval = effect as RequireApprovalEffect;
      if (!output.requiredApproval) {
        output.requiredApproval = approval;
      } else {
        // Take the highest level (lexicographic comparison: "manager" < "vp" < etc.)
        // Use a numeric mapping for well-known levels, fall back to lexicographic
        const currentRank = approvalRank(output.requiredApproval.level);
        const newRank = approvalRank(approval.level);
        if (newRank > currentRank) {
          output.requiredApproval = approval;
        }
      }
      break;
    }
    case "enrich": {
      const enrich = effect as EnrichEffect;
      safeAssign(output.enrichFields, enrich.setFields);
      break;
    }
    case "execute_action": {
      output.actions.push(effect as ExecuteActionEffect);
      break;
    }
    case "trigger_flow": {
      output.flows.push(effect as TriggerFlowEffect);
      break;
    }
    default: {
      const _exhaustive: never = effect;
      break;
    }
  }
}

/**
 * Return a numeric rank for known approval levels.
 * Higher number = higher authority required.
 */
function approvalRank(level: string): number {
  const ranks: Record<string, number> = {
    team_lead: 1,
    manager: 2,
    director: 3,
    vp: 4,
    cxo: 5,
    ceo: 6,
  };
  return ranks[level] ?? 0;
}
