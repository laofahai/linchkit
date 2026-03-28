/**
 * Derived Property Engine (spec 48)
 *
 * Provides safe expression evaluation and runtime resolution of derived fields.
 * Derived fields compute their values from other fields, rather than user input.
 *
 * Types:
 * - expression: arithmetic/logic on fields within the same record
 * - concat: string concatenation of multiple fields
 * - function: custom compute function
 * - aggregate: cross-record aggregation via Link system (SUM, COUNT, AVG, MIN, MAX)
 *
 * Strategies:
 * - store: persisted to DB, recalculated on write (default)
 * - compute: calculated on read, not persisted
 *
 * Sub-modules:
 * - expression-parser.ts: tokenizer, recursive descent parser, evaluateExpression()
 * - safe-evaluator.ts: DerivedConfig types, resolveDerivedValue()
 * - aggregate-engine.ts: resolveAggregateValue(), computeAggregate()
 * - derived-registry.ts: DerivedPropertyEngine, createDerivedPropertyEngine()
 */

import type { FieldDefinition } from "../types/schema";

// Re-export expression parser
export { evaluateExpression } from "./expression-parser";

// Re-export type definitions and sync evaluator
export type {
  AggregateDerived,
  ConcatDerived,
  DerivedConfig,
  ExpressionDerived,
  FunctionDerived,
} from "./safe-evaluator";
export { resolveDerivedValue } from "./safe-evaluator";

// Re-export aggregate engine
export { computeAggregate, resolveAggregateValue } from "./aggregate-engine";

// Re-export registry and engine
export type { CascadeTarget, DerivedFieldInfo } from "./derived-registry";
export { createDerivedPropertyEngine, DerivedPropertyEngine } from "./derived-registry";

// ── Helpers ──────────────────────────────────────────────────

/**
 * Check if a field has a derived config (convenience type guard).
 */
export function isDerivedField(field: FieldDefinition): boolean {
  return field.derived != null;
}

/**
 * Get the strategy for a derived field (defaults to "store").
 */
export function getDerivedStrategy(field: FieldDefinition): "store" | "compute" {
  return (field.derived?.strategy as "store" | "compute") ?? "store";
}
