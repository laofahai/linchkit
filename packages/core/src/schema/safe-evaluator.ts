/**
 * Safe Evaluator (spec 48)
 *
 * Defines derived field type configurations and dispatches resolution
 * to the appropriate evaluator (expression parser, concat, function).
 * For aggregate types, use aggregate-engine.ts instead.
 */

import { evaluateExpression } from "./expression-parser";

// ── Derived field type definitions ────────────────────────────

/** Expression-based derivation: arithmetic/logic on same-record fields */
export interface ExpressionDerived {
  type: "expression";
  /** Expression string, e.g. "amount * quantity", "price - discount" */
  expr: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** String concatenation derivation */
export interface ConcatDerived {
  type: "concat";
  /** Field names to concatenate */
  fields: string[];
  /** Separator between values (default: "") */
  separator?: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** Custom function derivation */
export interface FunctionDerived {
  type: "function";
  /** Compute function — receives the record, returns the derived value */
  compute: (record: Record<string, unknown>) => unknown;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** Aggregate derivation: cross-record aggregation via Link system */
export interface AggregateDerived {
  type: "aggregate";
  source: { link: string; schema: string; filter?: Record<string, unknown> };
  op: "sum" | "count" | "avg" | "min" | "max";
  field?: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

export type DerivedConfig = ExpressionDerived | ConcatDerived | FunctionDerived | AggregateDerived;

// ── Synchronous derived value resolution ─────────────────────

/**
 * Resolve a single derived field value for a record (synchronous).
 * For aggregate type, returns undefined — use resolveAggregateValue() instead.
 *
 * @param derived - The derived configuration from the field definition
 * @param record - The current record data
 * @returns The computed value, or undefined if cannot compute (e.g. aggregate without data provider)
 */
export function resolveDerivedValue(
  derived: DerivedConfig,
  record: Record<string, unknown>,
): unknown {
  switch (derived.type) {
    case "expression":
      return evaluateExpression(derived.expr, record);

    case "concat": {
      const sep = derived.separator ?? "";
      return derived.fields
        .map((f) => {
          const v = record[f];
          return v === null || v === undefined ? "" : String(v);
        })
        .filter((s) => s !== "")
        .join(sep);
    }

    case "function":
      return derived.compute(record);

    case "aggregate":
      // Aggregate requires async data provider access — use resolveAggregateValue()
      return undefined;

    default:
      return undefined;
  }
}
