import { describe, expect, test } from "bun:test";
import type { FieldVisibilityCondition } from "@linchkit/core/types";
import { evaluateVisibility } from "../src/lib/field-visibility";

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

  // ── gt ──

  test("gt: returns true when field value is greater than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gt", value: 3 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("gt: returns false when field value equals threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gt", value: 5 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("gt: returns false when field value is less than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gt", value: 10 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("gt: returns false when field or value is not a number", () => {
    const cond: FieldVisibilityCondition = { field: "priority", operator: "gt", value: 3 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── gte ──

  test("gte: returns true when field value equals threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gte", value: 5 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("gte: returns true when field value is greater than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gte", value: 3 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("gte: returns false when field value is less than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "gte", value: 10 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── lt ──

  test("lt: returns true when field value is less than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lt", value: 10 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("lt: returns false when field value equals threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lt", value: 5 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("lt: returns false when field value is greater than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lt", value: 3 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── lte ──

  test("lte: returns true when field value equals threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lte", value: 5 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("lte: returns true when field value is less than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lte", value: 10 };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("lte: returns false when field value is greater than threshold", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "lte", value: 3 };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  // ── contains ──

  test("contains: returns true when string field contains substring (case-insensitive)", () => {
    const cond: FieldVisibilityCondition = { field: "category", operator: "contains", value: "sec" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("contains: returns true for exact match", () => {
    const cond: FieldVisibilityCondition = { field: "category", operator: "contains", value: "security" };
    expect(evaluateVisibility(cond, data)).toBe(true);
  });

  test("contains: returns false when substring not found", () => {
    const cond: FieldVisibilityCondition = { field: "category", operator: "contains", value: "billing" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("contains: returns false when field is not a string", () => {
    const cond: FieldVisibilityCondition = { field: "count", operator: "contains", value: "5" };
    expect(evaluateVisibility(cond, data)).toBe(false);
  });

  test("contains: returns false when value is not a string", () => {
    const cond: FieldVisibilityCondition = { field: "category", operator: "contains", value: 42 };
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
