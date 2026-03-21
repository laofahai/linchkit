/**
 * Rule evaluation engine
 *
 * Evaluates multiple RuleDefinitions against a context, handling:
 * - Priority ordering (descending)
 * - Short-circuiting on block effects
 * - Effect merging across all triggered rules
 */

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
  WarnEffect,
} from "../types/rule";
import { type ConditionContext, evaluateCondition } from "./condition-evaluator";

// ── Input / Output types ────────────────────────────

export interface RuleEvalInput {
  target: Record<string, unknown>;
  actor: { type: string; id: string; groups: string[] };
  context?: Record<string, unknown>;
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
  /** Per-rule evaluation details */
  results: RuleEvaluationResult[];
  /** Total evaluation duration in ms */
  duration: number;
}

/**
 * Evaluate a list of rules against the given input context.
 *
 * Rules are sorted by priority (descending). Block effects cause
 * short-circuiting: once a block is encountered, remaining rules
 * are skipped but all block reasons so far are collected.
 */
export async function evaluateRules(
  rules: RuleDefinition[],
  input: RuleEvalInput,
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
    results: [],
    duration: 0,
  };

  if (rules.length === 0) {
    output.duration = performance.now() - totalStart;
    return output;
  }

  // Sort by priority descending (higher priority first); default to 0
  const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const ctx: ConditionContext = {
    target: input.target,
    context: input.context ?? {},
    actor: input.actor,
  };

  for (const rule of sorted) {
    const ruleStart = performance.now();

    let triggered: boolean;
    if (typeof rule.condition === "function") {
      triggered = await (rule.condition as CodeCondition)({
        target: ctx.target,
        context: ctx.context,
        actor: ctx.actor,
      });
    } else {
      triggered = evaluateCondition(rule.condition as DeclarativeCondition, ctx);
    }

    const duration = performance.now() - ruleStart;

    const result: RuleEvaluationResult = {
      rule: rule.name,
      triggered,
      effect: triggered ? rule.effect : null,
      duration,
    };
    output.results.push(result);

    if (!triggered) continue;

    output.triggered = true;
    mergeEffect(output, rule.effect);

    // Short-circuit: if we just got blocked, stop evaluating further rules
    if (rule.effect.type === "block") {
      break;
    }
  }

  output.duration = performance.now() - totalStart;
  return output;
}

/**
 * Merge a single effect into the cumulative output.
 */
function mergeEffect(output: RuleEvalOutput, effect: RuleEffect): void {
  switch (effect.type) {
    case "block": {
      const block = effect as BlockEffect;
      output.blocked = true;
      output.blockReasons.push(block.reason ?? block.message);
      break;
    }
    case "warn": {
      output.warnings.push(effect as WarnEffect);
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
      Object.assign(output.enrichFields, enrich.setFields);
      break;
    }
    case "execute_action": {
      output.actions.push(effect as ExecuteActionEffect);
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
