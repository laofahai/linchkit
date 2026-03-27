import { describe, expect, it } from "bun:test";
import { applyOverride, deepMerge, resolveOverrides, resolveRuleOverride } from "../src/runtime/override-resolver";
import type { RuleDefinition } from "../src/types/rule";

// ── deepMerge ─────────────────────────────────────────

describe("deepMerge", () => {
  it("merges top-level keys", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep merges nested objects", () => {
    const result = deepMerge(
      { config: { threshold: 100, mode: "strict" } },
      { config: { threshold: 500 } },
    );
    expect(result).toEqual({ config: { threshold: 500, mode: "strict" } });
  });

  it("replaces arrays (not merges)", () => {
    const result = deepMerge({ tags: ["a", "b"] }, { tags: ["c"] });
    expect(result).toEqual({ tags: ["c"] });
  });

  it("does not mutate original", () => {
    const original = { a: 1, nested: { x: 10 } };
    const result = deepMerge(original, { nested: { y: 20 } });
    expect(original.nested).toEqual({ x: 10 });
    expect(result.nested).toEqual({ x: 10, y: 20 });
  });
});

// ── applyOverride ─────────────────────────────────────

describe("applyOverride", () => {
  it("returns original if no override", () => {
    const def = { name: "test", overridable: true };
    expect(applyOverride(def, undefined)).toBe(def);
  });

  it("returns original if not overridable", () => {
    const def = { name: "test" }; // overridable is undefined → not overridable
    const result = applyOverride(def, { extra: "value" });
    expect(result).toBe(def);
  });

  it("returns original if overridable is false", () => {
    const def = { name: "test", overridable: false };
    const result = applyOverride(def, { extra: "value" });
    expect(result).toBe(def);
  });

  it("applies override when overridable is true", () => {
    const def = { name: "test", overridable: true, threshold: 100 };
    const result = applyOverride(def, { threshold: 500 });
    expect(result.threshold).toBe(500);
    expect(result.name).toBe("test");
    expect(result.overridable).toBe(true);
  });

  it("protects name and overridable from override", () => {
    const def = { name: "original", overridable: true, value: 1 };
    const result = applyOverride(def, { name: "hacked", overridable: false, value: 2 });
    expect(result.name).toBe("original");
    expect(result.overridable).toBe(true);
    expect(result.value).toBe(2);
  });
});

// ── resolveOverrides ──────────────────────────────────

describe("resolveOverrides", () => {
  it("returns original list when no overrides", () => {
    const defs = [
      { name: "a", overridable: true },
      { name: "b", overridable: false },
    ];
    const result = resolveOverrides(defs, new Map());
    expect(result).toBe(defs);
  });

  it("applies overrides only to overridable definitions", () => {
    const defs = [
      { name: "a", overridable: true, value: 1 },
      { name: "b", overridable: false, value: 2 },
    ];
    const overrides = new Map<string, Record<string, unknown>>([
      ["a", { value: 10 }],
      ["b", { value: 20 }],
    ]);
    const result = resolveOverrides(defs, overrides);
    expect(result[0].value).toBe(10); // overridable: applied
    expect(result[1].value).toBe(2);  // not overridable: unchanged
  });

  it("leaves definitions without matching overrides unchanged", () => {
    const defs = [
      { name: "a", overridable: true, value: 1 },
      { name: "b", overridable: true, value: 2 },
    ];
    const overrides = new Map<string, Record<string, unknown>>([["a", { value: 10 }]]);
    const result = resolveOverrides(defs, overrides);
    expect(result[0].value).toBe(10);
    expect(result[1].value).toBe(2);
  });
});

// ── resolveRuleOverride ────────────────────────────────

describe("resolveRuleOverride", () => {
  const baseRule: RuleDefinition = {
    name: "amount_check",
    label: "Amount Check",
    overridable: true,
    trigger: { action: "create" },
    condition: { field: "target.amount", operator: "gt", value: 10000 },
    effect: { type: "require_approval", level: "director" },
  };

  it("overrides condition value (spec 02 example)", () => {
    const result = resolveRuleOverride(baseRule, {
      condition: { field: "target.amount", operator: "gt", value: 50000 },
    });
    expect(result.condition).toEqual({
      field: "target.amount",
      operator: "gt",
      value: 50000,
    });
    expect(result.effect).toEqual(baseRule.effect); // unchanged
  });

  it("overrides effect", () => {
    const result = resolveRuleOverride(baseRule, {
      effect: { type: "require_approval", level: "ceo" },
    });
    expect((result.effect as { level: string }).level).toBe("ceo");
  });

  it("does not override non-overridable rule", () => {
    const noOverride: RuleDefinition = { ...baseRule, overridable: false };
    const result = resolveRuleOverride(noOverride, { condition: { value: 99999 } });
    expect(result).toBe(noOverride);
  });
});
