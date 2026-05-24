/**
 * Pattern-detector scenario matchers — Spec 69 Phase 4.
 */

import type { MatcherFn, MatcherResult, PatternEvalOutput, PatternEvalOutputItem } from "../types";
import type { MatcherRegistry } from "./registry";

function fail(matcher: string, message: string, observed?: unknown): MatcherResult {
  return { matcher, passed: false, strict: true, observed, message };
}
function pass(matcher: string, observed?: unknown): MatcherResult {
  return { matcher, passed: true, strict: true, observed };
}

/** Assert exact number of patterns detected. */
const pattern_count: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "number") return fail("pattern_count", "arg 'value' must be a number");
  if (output.length === args.value) return pass("pattern_count", output.length);
  return fail(
    "pattern_count",
    `expected ${args.value} pattern(s), got ${output.length}`,
    output.length,
  );
};

/** Assert at least N patterns detected. */
const pattern_count_min: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "number")
    return fail("pattern_count_min", "arg 'value' must be a number");
  if (output.length >= args.value) return pass("pattern_count_min", output.length);
  return fail(
    "pattern_count_min",
    `expected ≥${args.value} pattern(s), got ${output.length}`,
    output.length,
  );
};

/** Assert that output includes a pattern of the given type. */
const pattern_type_includes: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("pattern_type_includes", "arg 'value' must be a string");
  const found = output.some((p: PatternEvalOutputItem) => p.type === args.value);
  if (found) return pass("pattern_type_includes", args.value);
  return fail(
    "pattern_type_includes",
    `expected pattern of type "${args.value}" but none found`,
    output.map((p: PatternEvalOutputItem) => p.type),
  );
};

/** Assert that no pattern of the given type is present. */
const pattern_type_absent: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("pattern_type_absent", "arg 'value' must be a string");
  const found = output.some((p: PatternEvalOutputItem) => p.type === args.value);
  if (!found) return pass("pattern_type_absent");
  return fail(
    "pattern_type_absent",
    `expected no pattern of type "${args.value}" but one was found`,
  );
};

/** Assert that at least one pattern has confidence >= the given value. */
const pattern_confidence_min: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "number")
    return fail("pattern_confidence_min", "arg 'value' must be a number");
  const found = output.some((p: PatternEvalOutputItem) => p.confidence >= (args.value as number));
  if (found) return pass("pattern_confidence_min");
  return fail(
    "pattern_confidence_min",
    `no pattern has confidence ≥ ${args.value}`,
    output.map((p: PatternEvalOutputItem) => p.confidence),
  );
};

/** Assert that all patterns relate to the given entity. */
const pattern_entity_equals: MatcherFn<PatternEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("pattern_entity_equals", "arg 'value' must be a string");
  const wrong = output.filter((p: PatternEvalOutputItem) => p.entity !== args.value);
  if (wrong.length === 0) return pass("pattern_entity_equals", args.value);
  return fail(
    "pattern_entity_equals",
    `patterns from unexpected entities: ${wrong.map((p: PatternEvalOutputItem) => p.entity).join(", ")}`,
  );
};

export const patternMatchers: Record<string, MatcherFn<PatternEvalOutput>> = {
  pattern_count,
  pattern_count_min,
  pattern_type_includes,
  pattern_type_absent,
  pattern_confidence_min,
  pattern_entity_equals,
};

export function registerPatternMatchers(registry: MatcherRegistry): void {
  for (const [name, fn] of Object.entries(patternMatchers)) {
    registry.register(name, fn as MatcherFn);
  }
}
