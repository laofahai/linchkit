/**
 * Intent-scenario matchers — implements §5.1 of spec 69.
 *
 * Every matcher operates on `IntentEvalOutput`, a scenario-neutral
 * shape defined in this package. The adapter that converts
 * `cap-ai-provider`'s `ActionProposal` to `IntentEvalOutput` is
 * delivered in a later phase; matchers are written so they can be
 * tested in isolation today.
 *
 * Convention: matchers MUST NOT throw. Malformed `args` produce a
 * failing `MatcherResult` with a clear message. The registry will
 * still wrap accidental throws, but matchers should fail-safe
 * deliberately.
 */

import type { IntentEvalOutput, MatcherFn, MatcherResult } from "../types";
import type { MatcherRegistry } from "./registry";

// ── helpers ─────────────────────────────────────────────

function fail(matcher: string, message: string, observed?: unknown): MatcherResult {
  return { matcher, passed: false, strict: true, observed, message };
}

function pass(matcher: string, observed?: unknown): MatcherResult {
  return { matcher, passed: true, strict: true, observed };
}

/**
 * Small structural deep-equal — sufficient for JSON-shaped fixture values.
 * Avoids pulling in lodash. Treats arrays and plain objects structurally;
 * other reference types fall back to `Object.is`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

// ── matchers ────────────────────────────────────────────

const action_equals: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!("value" in args)) {
    return fail("action_equals", "missing arg: value");
  }
  const expected = args.value;
  if (expected !== null && !isString(expected)) {
    return fail("action_equals", "arg 'value' must be string or null", expected);
  }
  if (output.action === expected) {
    return pass("action_equals", output.action);
  }
  return fail(
    "action_equals",
    `expected action ${JSON.stringify(expected)}, got ${JSON.stringify(output.action)}`,
    output.action,
  );
};

const confidence_min: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isNumber(args.value)) {
    return fail("confidence_min", "arg 'value' must be a finite number", args.value);
  }
  if (output.confidence >= args.value) {
    return pass("confidence_min", output.confidence);
  }
  return fail(
    "confidence_min",
    `expected confidence >= ${args.value}, got ${output.confidence}`,
    output.confidence,
  );
};

const confidence_max: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isNumber(args.value)) {
    return fail("confidence_max", "arg 'value' must be a finite number", args.value);
  }
  if (output.confidence <= args.value) {
    return pass("confidence_max", output.confidence);
  }
  return fail(
    "confidence_max",
    `expected confidence <= ${args.value}, got ${output.confidence}`,
    output.confidence,
  );
};

const input_must_include: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isString(args.key)) {
    return fail("input_must_include", "arg 'key' must be a string", args.key);
  }
  if (!("value" in args)) {
    return fail("input_must_include", "missing arg: value");
  }
  const observed = output.input[args.key];
  if (!Object.hasOwn(output.input, args.key)) {
    return fail("input_must_include", `key '${args.key}' missing from input`, observed);
  }
  if (deepEqual(observed, args.value)) {
    return pass("input_must_include", observed);
  }
  return fail(
    "input_must_include",
    `input['${args.key}'] expected ${JSON.stringify(args.value)}, got ${JSON.stringify(observed)}`,
    observed,
  );
};

const input_must_omit: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isString(args.key)) {
    return fail("input_must_omit", "arg 'key' must be a string", args.key);
  }
  const present = Object.hasOwn(output.input, args.key) && output.input[args.key] !== undefined;
  if (!present) {
    return pass("input_must_omit", undefined);
  }
  return fail(
    "input_must_omit",
    `expected input to omit '${args.key}', got ${JSON.stringify(output.input[args.key])}`,
    output.input[args.key],
  );
};

const missing_fields_includes: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isStringArray(args.fields)) {
    return fail("missing_fields_includes", "arg 'fields' must be string[]", args.fields);
  }
  const missing = args.fields.filter((f) => !output.missingFields.includes(f));
  if (missing.length === 0) {
    return pass("missing_fields_includes", output.missingFields);
  }
  return fail(
    "missing_fields_includes",
    `missingFields did not include: ${missing.join(", ")}`,
    output.missingFields,
  );
};

const alternatives_min_count: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isNumber(args.value)) {
    return fail("alternatives_min_count", "arg 'value' must be a finite number", args.value);
  }
  const count = output.alternatives?.length ?? 0;
  if (count >= args.value) {
    return pass("alternatives_min_count", count);
  }
  return fail(
    "alternatives_min_count",
    `expected at least ${args.value} alternatives, got ${count}`,
    count,
  );
};

const alternatives_includes_action: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isString(args.value)) {
    return fail("alternatives_includes_action", "arg 'value' must be a string", args.value);
  }
  const alternatives = output.alternatives ?? [];
  const hit = alternatives.some((alt) => alt.action === args.value);
  if (hit) {
    return pass(
      "alternatives_includes_action",
      alternatives.map((alt) => alt.action),
    );
  }
  return fail(
    "alternatives_includes_action",
    `no alternative with action '${args.value}'`,
    alternatives.map((alt) => alt.action),
  );
};

const alternatives_excludes_primary: MatcherFn<IntentEvalOutput> = (output) => {
  const alternatives = output.alternatives ?? [];
  if (alternatives.length === 0) {
    return pass("alternatives_excludes_primary", []);
  }
  const duplicate = alternatives.find((alt) => alt.action === output.action);
  if (!duplicate) {
    return pass(
      "alternatives_excludes_primary",
      alternatives.map((alt) => alt.action),
    );
  }
  return fail(
    "alternatives_excludes_primary",
    `alternative duplicates primary action '${output.action}'`,
    alternatives.map((alt) => alt.action),
  );
};

const proposal_is_null: MatcherFn<IntentEvalOutput> = (output) => {
  if (output.action === null) {
    return pass("proposal_is_null", output.action);
  }
  return fail(
    "proposal_is_null",
    `expected proposal to be null (refusal), got action '${output.action}'`,
    output.action,
  );
};

const latency_max_ms: MatcherFn<IntentEvalOutput> = (output, args) => {
  if (!isNumber(args.value)) {
    return fail("latency_max_ms", "arg 'value' must be a finite number", args.value);
  }
  if (output.latencyMs === undefined) {
    // Replay mode — latency was not recorded. Treat as benign observation, not a failure.
    return pass("latency_max_ms", undefined);
  }
  if (output.latencyMs <= args.value) {
    return pass("latency_max_ms", output.latencyMs);
  }
  return fail(
    "latency_max_ms",
    `expected latency <= ${args.value}ms, got ${output.latencyMs}ms`,
    output.latencyMs,
  );
};

/**
 * Map of name → matcher for caller convenience. Ordered to match
 * spec 69 §5.1 for readability when reviewing the catalog.
 */
export const intentMatchers: Record<string, MatcherFn<IntentEvalOutput>> = {
  action_equals,
  confidence_min,
  confidence_max,
  input_must_include,
  input_must_omit,
  missing_fields_includes,
  alternatives_min_count,
  alternatives_includes_action,
  alternatives_excludes_primary,
  proposal_is_null,
  latency_max_ms,
};

/**
 * Register every intent matcher onto a registry in one call.
 * Throws if any matcher name collides with one already registered.
 */
export function registerIntentMatchers(registry: MatcherRegistry<IntentEvalOutput>): void {
  for (const [name, fn] of Object.entries(intentMatchers)) {
    registry.register(name, fn);
  }
}
