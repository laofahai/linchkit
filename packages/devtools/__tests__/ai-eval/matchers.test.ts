import { describe, expect, it } from "bun:test";
import {
  createMatcherRegistry,
  type IntentEvalOutput,
  intentMatchers,
  type MatcherFn,
  registerIntentMatchers,
} from "../../src/ai-eval";

/** Build a minimally-valid IntentEvalOutput, then override fields per test. */
function buildOutput(overrides: Partial<IntentEvalOutput> = {}): IntentEvalOutput {
  return {
    action: "create_purchase_request",
    input: { amount: 5000 },
    confidence: 0.9,
    missingFields: [],
    explanation: "stub",
    ...overrides,
  };
}

describe("intentMatchers.action_equals", () => {
  const matcher = intentMatchers.action_equals as MatcherFn<IntentEvalOutput>;

  it("passes when action matches", () => {
    const result = matcher(buildOutput(), { value: "create_purchase_request" });
    expect(result.passed).toBe(true);
    expect(result.observed).toBe("create_purchase_request");
  });

  it("fails when action does not match", () => {
    const result = matcher(buildOutput(), { value: "approve_order" });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("approve_order");
  });

  it("passes when both expected and actual are null (refusal)", () => {
    const result = matcher(buildOutput({ action: null }), { value: null });
    expect(result.passed).toBe(true);
  });

  it("fails on malformed args", () => {
    const result = matcher(buildOutput(), { value: 42 });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("string or null");
  });
});

describe("intentMatchers.confidence_min", () => {
  const matcher = intentMatchers.confidence_min as MatcherFn<IntentEvalOutput>;

  it("passes when confidence meets the floor", () => {
    expect(matcher(buildOutput({ confidence: 0.8 }), { value: 0.7 }).passed).toBe(true);
  });

  it("fails when confidence is below the floor", () => {
    const result = matcher(buildOutput({ confidence: 0.5 }), { value: 0.7 });
    expect(result.passed).toBe(false);
    expect(result.observed).toBe(0.5);
  });

  it("treats equal-to-floor as passing", () => {
    expect(matcher(buildOutput({ confidence: 0.7 }), { value: 0.7 }).passed).toBe(true);
  });
});

describe("intentMatchers.confidence_max", () => {
  const matcher = intentMatchers.confidence_max as MatcherFn<IntentEvalOutput>;

  it("passes when confidence is below the ceiling (ambiguous fixture)", () => {
    expect(matcher(buildOutput({ confidence: 0.3 }), { value: 0.4 }).passed).toBe(true);
  });

  it("fails when overconfident", () => {
    const result = matcher(buildOutput({ confidence: 0.55 }), { value: 0.4 });
    expect(result.passed).toBe(false);
  });

  it("fails when args.value is missing", () => {
    const result = matcher(buildOutput(), {});
    expect(result.passed).toBe(false);
  });
});

describe("intentMatchers.input_must_include", () => {
  const matcher = intentMatchers.input_must_include as MatcherFn<IntentEvalOutput>;

  it("passes on scalar equality", () => {
    const result = matcher(buildOutput({ input: { amount: 5000 } }), {
      key: "amount",
      value: 5000,
    });
    expect(result.passed).toBe(true);
  });

  it("uses deep equality for nested objects", () => {
    const out = buildOutput({ input: { meta: { tags: ["a", "b"] } } });
    const result = matcher(out, { key: "meta", value: { tags: ["a", "b"] } });
    expect(result.passed).toBe(true);
  });

  it("fails when value differs deeply", () => {
    const out = buildOutput({ input: { meta: { tags: ["a", "b"] } } });
    const result = matcher(out, { key: "meta", value: { tags: ["a", "c"] } });
    expect(result.passed).toBe(false);
  });

  it("fails when the key is absent", () => {
    const result = matcher(buildOutput({ input: {} }), { key: "amount", value: 5000 });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("missing");
  });
});

describe("intentMatchers.input_must_omit", () => {
  const matcher = intentMatchers.input_must_omit as MatcherFn<IntentEvalOutput>;

  it("passes when key is absent", () => {
    const result = matcher(buildOutput({ input: { amount: 5000 } }), { key: "secret" });
    expect(result.passed).toBe(true);
  });

  it("treats explicit undefined as omitted", () => {
    const result = matcher(buildOutput({ input: { secret: undefined } }), { key: "secret" });
    expect(result.passed).toBe(true);
  });

  it("fails when key is present", () => {
    const result = matcher(buildOutput({ input: { secret: "leak" } }), { key: "secret" });
    expect(result.passed).toBe(false);
    expect(result.observed).toBe("leak");
  });
});

describe("intentMatchers.missing_fields_includes", () => {
  const matcher = intentMatchers.missing_fields_includes as MatcherFn<IntentEvalOutput>;

  it("passes when all listed fields are present in missingFields", () => {
    const out = buildOutput({ missingFields: ["amount", "vendor"] });
    expect(matcher(out, { fields: ["amount"] }).passed).toBe(true);
    expect(matcher(out, { fields: ["amount", "vendor"] }).passed).toBe(true);
  });

  it("fails when any listed field is absent", () => {
    const out = buildOutput({ missingFields: ["amount"] });
    const result = matcher(out, { fields: ["amount", "vendor"] });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("vendor");
  });

  it("passes for an empty target list (vacuously)", () => {
    expect(matcher(buildOutput({ missingFields: [] }), { fields: [] }).passed).toBe(true);
  });
});

describe("intentMatchers.alternatives_min_count", () => {
  const matcher = intentMatchers.alternatives_min_count as MatcherFn<IntentEvalOutput>;

  it("passes when alternatives count meets the floor", () => {
    const out = buildOutput({
      alternatives: [buildOutput({ action: "approve_order" })],
    });
    expect(matcher(out, { value: 1 }).passed).toBe(true);
  });

  it("fails when alternatives are missing", () => {
    const result = matcher(buildOutput(), { value: 1 });
    expect(result.passed).toBe(false);
    expect(result.observed).toBe(0);
  });
});

describe("intentMatchers.alternatives_includes_action", () => {
  const matcher = intentMatchers.alternatives_includes_action as MatcherFn<IntentEvalOutput>;

  it("passes when an alternative carries the named action", () => {
    const out = buildOutput({
      alternatives: [buildOutput({ action: "approve_order" })],
    });
    expect(matcher(out, { value: "approve_order" }).passed).toBe(true);
  });

  it("fails when no alternative matches", () => {
    const out = buildOutput({
      alternatives: [buildOutput({ action: "approve_order" })],
    });
    expect(matcher(out, { value: "submit_request" }).passed).toBe(false);
  });

  it("fails when alternatives are absent", () => {
    expect(matcher(buildOutput(), { value: "approve_order" }).passed).toBe(false);
  });
});

describe("intentMatchers.alternatives_excludes_primary", () => {
  const matcher = intentMatchers.alternatives_excludes_primary as MatcherFn<IntentEvalOutput>;

  it("passes when alternatives differ from primary", () => {
    const out = buildOutput({
      action: "submit_request",
      alternatives: [buildOutput({ action: "approve_order" })],
    });
    expect(matcher(out, {}).passed).toBe(true);
  });

  it("passes when alternatives array is empty", () => {
    expect(matcher(buildOutput({ alternatives: [] }), {}).passed).toBe(true);
  });

  it("passes when alternatives are undefined", () => {
    expect(matcher(buildOutput(), {}).passed).toBe(true);
  });

  it("fails when an alternative duplicates the primary action", () => {
    const out = buildOutput({
      action: "submit_request",
      alternatives: [buildOutput({ action: "submit_request" })],
    });
    expect(matcher(out, {}).passed).toBe(false);
  });
});

describe("intentMatchers.proposal_is_null", () => {
  const matcher = intentMatchers.proposal_is_null as MatcherFn<IntentEvalOutput>;

  it("passes when action is null", () => {
    expect(matcher(buildOutput({ action: null }), {}).passed).toBe(true);
  });

  it("fails when an action was proposed", () => {
    const result = matcher(buildOutput(), {});
    expect(result.passed).toBe(false);
    expect(result.message).toContain("create_purchase_request");
  });
});

describe("intentMatchers.latency_max_ms", () => {
  const matcher = intentMatchers.latency_max_ms as MatcherFn<IntentEvalOutput>;

  it("passes when latency is under the ceiling", () => {
    expect(matcher(buildOutput({ latencyMs: 500 }), { value: 1000 }).passed).toBe(true);
  });

  it("fails when latency exceeds the ceiling", () => {
    const result = matcher(buildOutput({ latencyMs: 1500 }), { value: 1000 });
    expect(result.passed).toBe(false);
    expect(result.observed).toBe(1500);
  });

  it("passes (benign observation) when latency is unknown in replay mode", () => {
    const result = matcher(buildOutput(), { value: 1000 });
    expect(result.passed).toBe(true);
    expect(result.observed).toBeUndefined();
  });
});

describe("matcher registry", () => {
  it("registers and looks up matchers", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(registry);
    expect(registry.list()).toContain("action_equals");
    expect(registry.get("action_equals")).toBeDefined();
  });

  it("throws on duplicate registration", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(registry);
    expect(() => registerIntentMatchers(registry)).toThrow(/already registered/);
  });

  it("returns a failing result for unknown matcher names (does not throw)", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    const result = registry.invoke({ name: "no_such_matcher", args: {} }, buildOutput());
    expect(result.passed).toBe(false);
    expect(result.message).toBe("unknown matcher: no_such_matcher");
    expect(result.strict).toBe(true);
  });

  it("wraps thrown matcher errors into a failing result", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    registry.register("explode", () => {
      throw new Error("kaboom");
    });
    const result = registry.invoke({ name: "explode", args: {} }, buildOutput());
    expect(result.passed).toBe(false);
    expect(result.message).toBe("kaboom");
  });

  it("defaults invocation.strict to true", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(registry);
    const result = registry.invoke(
      { name: "action_equals", args: { value: "create_purchase_request" } },
      buildOutput(),
    );
    expect(result.strict).toBe(true);
  });

  it("honours invocation.strict=false override", () => {
    const registry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(registry);
    const result = registry.invoke(
      { name: "latency_max_ms", args: { value: 100 }, strict: false },
      buildOutput({ latencyMs: 500 }),
    );
    expect(result.strict).toBe(false);
    expect(result.passed).toBe(false);
  });
});
