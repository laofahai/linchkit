import { describe, expect, test } from "bun:test";
import { evaluateVisibility } from "../src/lib/field-visibility";
import type { FieldVisibilityCondition } from "@linchkit/core/types";

describe("evaluateVisibility", () => {
  const data = {
    priority: "high",
    category: "security",
    name: "Test",
    empty_field: "",
    null_field: null,
    count: 5,
  };

  test("returns true when condition is undefined (always visible)", () => {
    expect(evaluateVisibility(undefined, data)).toBe(true);
  });

  // ── eq ──

  test("eq: returns true when field matches value", () => {
    const cond: FieldVisibilityCondition = { field: "priority", operator: "eq", value: "high" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("eq: returns false when field does not match value", () => {
    const cond: FieldVisibilityCondition = { field: "priority", operator: "eq", value: "low" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── neq ──

  test("neq: returns true when field does not match value", () => {
    const cond: FieldVisibilityCondition = { field: "priority", operator: "neq", value: "low" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("neq: returns false when field matches value", () => {
    const cond: FieldVisibilityCondition = { field: "priority", operator: "neq", value: "high" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── in ──

  test("in: returns true when field value is in the array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "in",
      value: ["high", "urgent"],
    };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("in: returns false when field value is not in the array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "in",
      value: ["low", "medium"],
    };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("in: returns false when value is not an array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "in",
      value: "high",
    };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── not_in ──

  test("not_in: returns true when field value is not in the array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "not_in",
      value: ["low", "medium"],
    };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("not_in: returns false when field value is in the array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "not_in",
      value: ["high", "urgent"],
    };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("not_in: returns true when value is not an array", () => {
    const cond: FieldVisibilityCondition = {
      field: "priority",
      operator: "not_in",
      value: "something",
    };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  // ── is_set ──

  test("is_set: returns true when field has a non-empty value", () => {
    const cond: FieldVisibilityCondition = { field: "name", operator: "is_set" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("is_set: returns false when field is empty string", () => {
    const cond: FieldVisibilityCondition = { field: "empty_field", operator: "is_set" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("is_set: returns false when field is null", () => {
    const cond: FieldVisibilityCondition = { field: "null_field", operator: "is_set" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("is_set: returns false when field is undefined (missing key)", () => {
    const cond: FieldVisibilityCondition = { field: "nonexistent", operator: "is_set" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── is_empty ──

  test("is_empty: returns true when field is empty string", () => {
    const cond: FieldVisibilityCondition = { field: "empty_field", operator: "is_empty" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("is_empty: returns true when field is null", () => {
    const cond: FieldVisibilityCondition = { field: "null_field", operator: "is_empty" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("is_empty: returns true when field is undefined", () => {
    const cond: FieldVisibilityCondition = { field: "nonexistent", operator: "is_empty" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("is_empty: returns false when field has a value", () => {
    const cond: FieldVisibilityCondition = { field: "name", operator: "is_empty" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── edge cases ──

  test("unknown operator defaults to true", () => {
    const cond = { field: "name", operator: "unknown_op" } as unknown as FieldVisibilityCondition;
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("works with numeric values", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "eq", value: 5 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("works with boolean values", () => {
    const boolData = { active: true };
    const cond: FieldVisibilityCondition = { field: "active", operator: "eq", value: true };
    expect(evaluateVisibility(cond, boolData)).toBe(true);
  });
});
