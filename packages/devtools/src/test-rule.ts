/**
 * testRule — Unit test utility for individual Rule definitions
 *
 * Evaluates a Rule's condition against provided context and returns the effect.
 */

import type {
  CodeCondition,
  DeclarativeCondition,
  RuleDefinition,
  RuleEffect,
  RuleEvaluationResult,
  SimpleCondition,
  CompositeCondition,
  NotCondition,
} from "@linchkit/core";

export interface TestRuleInput {
  target: Record<string, unknown>;
  actor?: { type: string; id?: string; roles?: string[] };
  context?: Record<string, unknown>;
}

/**
 * Evaluate a single Rule against the given input context.
 */
export async function testRule(
  rule: RuleDefinition,
  input: TestRuleInput,
): Promise<RuleEvaluationResult> {
  const start = performance.now();
  const actor = {
    type: input.actor?.type ?? "human",
    id: input.actor?.id ?? "test-actor",
    roles: input.actor?.roles ?? [],
  };

  let triggered: boolean;

  if (typeof rule.condition === "function") {
    const codeFn = rule.condition as CodeCondition;
    triggered = await codeFn({
      target: input.target,
      context: input.context ?? {},
      actor,
    });
  } else {
    triggered = evaluateDeclarative(rule.condition as DeclarativeCondition, {
      target: input.target,
      context: input.context ?? {},
      actor,
    });
  }

  const duration = performance.now() - start;

  return {
    rule: rule.name,
    triggered,
    effect: triggered ? rule.effect : null,
    duration,
  };
}

// ── Declarative condition evaluator ─────────────────

interface EvalContext {
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  actor: { type: string; id: string; roles: string[] };
}

function evaluateDeclarative(condition: DeclarativeCondition, ctx: EvalContext): boolean {
  if ("conditions" in condition) {
    return evaluateComposite(condition as CompositeCondition, ctx);
  }
  if ("condition" in condition && (condition as NotCondition).operator === "not") {
    return !evaluateDeclarative((condition as NotCondition).condition, ctx);
  }
  return evaluateSimple(condition as SimpleCondition, ctx);
}

function evaluateComposite(condition: CompositeCondition, ctx: EvalContext): boolean {
  if (condition.operator === "and") {
    return condition.conditions.every((c) => evaluateDeclarative(c, ctx));
  }
  return condition.conditions.some((c) => evaluateDeclarative(c, ctx));
}

function evaluateSimple(condition: SimpleCondition, ctx: EvalContext): boolean {
  const value = resolveField(condition.field, ctx);
  const expected = condition.value;

  switch (condition.operator) {
    case "eq":
      return value === expected;
    case "neq":
      return value !== expected;
    case "gt":
      return typeof value === "number" && typeof expected === "number" && value > expected;
    case "gte":
      return typeof value === "number" && typeof expected === "number" && value >= expected;
    case "lt":
      return typeof value === "number" && typeof expected === "number" && value < expected;
    case "lte":
      return typeof value === "number" && typeof expected === "number" && value <= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(value);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(value);
    case "is_null":
      return value === null || value === undefined;
    case "not_null":
      return value !== null && value !== undefined;
    case "contains":
      if (typeof value === "string" && typeof expected === "string") return value.includes(expected);
      if (Array.isArray(value)) return value.includes(expected);
      return false;
    default:
      return false;
  }
}

function resolveField(path: string, ctx: EvalContext): unknown {
  const parts = path.split(".");
  let current: unknown = ctx;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
