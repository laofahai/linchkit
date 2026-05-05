/**
 * Shared declarative condition evaluator
 *
 * Evaluates SimpleCondition, CompositeCondition, and NotCondition
 * against a flat context object with support for nested field paths.
 */

import type { ExecutionMeta } from "../types/execution-meta";
import type {
  CompositeCondition,
  DeclarativeCondition,
  NotCondition,
  SimpleCondition,
} from "../types/rule";

export interface ConditionContext {
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  actor: { type: string; id: string; groups: string[] };
  /** Current execution meta — resolves `meta.*` field paths (Spec 65 §6). */
  meta?: ExecutionMeta;
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
 *
 * - `meta.<key>[.<nested>...]` — resolves against `ctx.meta` (Spec 65 §6).
 *   Missing meta or missing key returns `undefined` (no throw).
 * - Otherwise — walks `ctx` (e.g. `target.department.name` -> `ctx.target.department.name`).
 */
export function resolveField(path: string, ctx: ConditionContext): unknown {
  const parts = path.split(".");

  if (parts[0] === "meta" && parts.length > 1) {
    const key = parts[1] as string;
    let current: unknown = ctx.meta?.get(key);
    for (let i = 2; i < parts.length; i++) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[parts[i] as string];
    }
    return current;
  }

  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
