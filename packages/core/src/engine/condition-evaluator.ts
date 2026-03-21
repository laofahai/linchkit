/**
 * Shared declarative condition evaluator
 *
 * Evaluates SimpleCondition, CompositeCondition, and NotCondition
 * against a flat context object with support for nested field paths.
 */

import type {
  CompositeCondition,
  DeclarativeCondition,
  NotCondition,
  SimpleCondition,
} from "../types/rule";

export interface ConditionContext {
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  actor: { type: string; id: string; roles: string[] };
}

/**
 * Evaluate a declarative condition tree against the given context.
 */
export function evaluateCondition(condition: DeclarativeCondition, ctx: ConditionContext): boolean {
  if ("conditions" in condition) {
    return evaluateComposite(condition as CompositeCondition, ctx);
  }
  if ("condition" in condition && (condition as NotCondition).operator === "not") {
    return !evaluateCondition((condition as NotCondition).condition, ctx);
  }
  return evaluateSimple(condition as SimpleCondition, ctx);
}

function evaluateComposite(condition: CompositeCondition, ctx: ConditionContext): boolean {
  if (condition.operator === "and") {
    return condition.conditions.every((c) => evaluateCondition(c, ctx));
  }
  return condition.conditions.some((c) => evaluateCondition(c, ctx));
}

function evaluateSimple(condition: SimpleCondition, ctx: ConditionContext): boolean {
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
      if (typeof value === "string" && typeof expected === "string")
        return value.includes(expected);
      if (Array.isArray(value)) return value.includes(expected);
      return false;
    default:
      return false;
  }
}

/**
 * Resolve a dot-separated field path against the context object.
 * E.g. "target.department.name" resolves ctx.target.department.name
 */
export function resolveField(path: string, ctx: ConditionContext): unknown {
  const parts = path.split(".");
  let current: unknown = ctx;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
