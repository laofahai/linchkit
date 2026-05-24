/**
 * Anomaly-detector scenario matchers — Spec 69 Phase 4.
 */

import type { AnomalyEvalOutput, AnomalyEvalOutputItem, MatcherFn, MatcherResult } from "../types";
import type { MatcherRegistry } from "./registry";

function fail(matcher: string, message: string, observed?: unknown): MatcherResult {
  return { matcher, passed: false, strict: true, observed, message };
}
function pass(matcher: string, observed?: unknown): MatcherResult {
  return { matcher, passed: true, strict: true, observed };
}

/** Assert exact number of anomalies detected. */
const anomaly_count: MatcherFn<AnomalyEvalOutput> = (output, args) => {
  if (typeof args.value !== "number") return fail("anomaly_count", "arg 'value' must be a number");
  if (output.length === args.value) return pass("anomaly_count", output.length);
  return fail(
    "anomaly_count",
    `expected ${args.value} anomaly/anomalies, got ${output.length}`,
    output.length,
  );
};

/** Assert at least N anomalies detected. */
const anomaly_count_min: MatcherFn<AnomalyEvalOutput> = (output, args) => {
  if (typeof args.value !== "number")
    return fail("anomaly_count_min", "arg 'value' must be a number");
  if (output.length >= args.value) return pass("anomaly_count_min", output.length);
  return fail(
    "anomaly_count_min",
    `expected ≥${args.value} anomaly/anomalies, got ${output.length}`,
    output.length,
  );
};

/** Assert that the output includes an anomaly of the given type. */
const anomaly_type_includes: MatcherFn<AnomalyEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("anomaly_type_includes", "arg 'value' must be a string");
  const found = output.some((a: AnomalyEvalOutputItem) => a.type === args.value);
  if (found) return pass("anomaly_type_includes", args.value);
  return fail(
    "anomaly_type_includes",
    `expected anomaly of type "${args.value}" but none found`,
    output.map((a: AnomalyEvalOutputItem) => a.type),
  );
};

/** Assert that no anomaly of the given type is present. */
const anomaly_type_absent: MatcherFn<AnomalyEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("anomaly_type_absent", "arg 'value' must be a string");
  const found = output.some((a: AnomalyEvalOutputItem) => a.type === args.value);
  if (!found) return pass("anomaly_type_absent");
  return fail(
    "anomaly_type_absent",
    `expected no anomaly of type "${args.value}" but one was found`,
  );
};

/** Assert that at least one anomaly has the given severity. */
const anomaly_severity_includes: MatcherFn<AnomalyEvalOutput> = (output, args) => {
  if (typeof args.value !== "string")
    return fail("anomaly_severity_includes", "arg 'value' must be a string");
  const found = output.some((a: AnomalyEvalOutputItem) => a.severity === args.value);
  if (found) return pass("anomaly_severity_includes", args.value);
  return fail(
    "anomaly_severity_includes",
    `expected at least one anomaly with severity "${args.value}"`,
    output.map((a: AnomalyEvalOutputItem) => a.severity),
  );
};

export const anomalyMatchers: Record<string, MatcherFn<AnomalyEvalOutput>> = {
  anomaly_count,
  anomaly_count_min,
  anomaly_type_includes,
  anomaly_type_absent,
  anomaly_severity_includes,
};

export function registerAnomalyMatchers(registry: MatcherRegistry): void {
  for (const [name, fn] of Object.entries(anomalyMatchers)) {
    registry.register(name, fn as MatcherFn);
  }
}
