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
  /**
   * The PERSISTED record, untouched by caller input — `target` is
   * `{ ...record, ...input }` (input wins), so authority/guard rules that must
   * not trust caller-supplied values resolve `record.*` paths instead.
   * Undefined when no stored row exists (create-shaped input, absent record).
   *
   * CAUTION: for `block` / `require_approval` effects gated on numeric
   * thresholds (`gt` / `gte` / `lt` / `lte`), prefer a `CodeCondition` with an
   * explicit fail-closed branch: when `record` is absent (or the field is
   * unset), the path resolves to `undefined`, the numeric operator's typeof
   * guard returns `false`, and the condition silently does NOT trigger — the
   * guard fails OPEN. Declarative `record.*` is safe for informational/enrich
   * rules and for `eq` / `neq` / `is_null`, whose semantics on `undefined` are
   * unambiguous.
   */
  record?: Record<string, unknown>;
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
 * Path segments that could leak prototype internals if walked as plain
 * property access — gemini PR review on #233 (security-medium). Any path
 * that traverses through one of these returns `undefined` so a
 * caller-controlled rule definition cannot probe `Object.prototype` or
 * the constructor chain via `meta.foo.constructor.prototype...`.
 */
const DANGEROUS_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Resolve a dot-separated field path against the context object.
 *
 * - `meta.<rest>` — resolves against `ctx.meta` (Spec 65 §6). Tries the full
 *   remaining path as a single ExecutionMeta key first (so flat dotted keys
 *   like `batch.parentExecutionId` still resolve), then falls back to
 *   progressively shorter prefixes with the unresolved suffix walked as
 *   nested object access. Missing meta or missing key returns `undefined`
 *   (no throw).
 * - Otherwise — walks `ctx` (e.g. `target.department.name` -> `ctx.target.department.name`;
 *   `record.amount` -> the persisted value on `ctx.record`, immune to input spoofing).
 *
 * Dangerous segments (`__proto__`, `constructor`, `prototype`) short-circuit
 * to `undefined` to prevent prototype-chain probing.
 */
export function resolveField(path: string, ctx: ConditionContext): unknown {
  const parts = path.split(".");

  if (parts[0] === "meta" && parts.length > 1) {
    if (!ctx.meta) return undefined;
    const restParts = parts.slice(1);
    for (let prefixLen = restParts.length; prefixLen >= 1; prefixLen--) {
      const candidateKey = restParts.slice(0, prefixLen).join(".");
      if (!ctx.meta.has(candidateKey)) continue;
      let current: unknown = ctx.meta.get(candidateKey);
      for (let i = prefixLen; i < restParts.length; i++) {
        const part = restParts[i] as string;
        if (current === null || current === undefined || DANGEROUS_PATH_SEGMENTS.has(part)) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    }
    return undefined;
  }

  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || DANGEROUS_PATH_SEGMENTS.has(part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
