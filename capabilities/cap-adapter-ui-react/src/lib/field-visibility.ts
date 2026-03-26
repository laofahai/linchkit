/**
 * Field visibility evaluation — pure function for visibleWhen conditions.
 *
 * Evaluates a FieldVisibilityCondition against the current form data
 * to determine whether a field should be visible.
 */

import type { FieldVisibilityCondition } from "@linchkit/core/types";

/**
 * Evaluate whether a field should be visible based on its visibleWhen condition.
 *
 * @param condition - The visibility condition to evaluate (undefined = always visible)
 * @param formData  - Current form values keyed by field name
 * @returns true if the field should be visible
 */
export function evaluateVisibility(
  condition: FieldVisibilityCondition | undefined,
  formData: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  const actual = formData[condition.field];

  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      if (!Array.isArray(condition.value)) return false;
      return (condition.value as unknown[]).includes(actual);
    case "not_in":
      if (!Array.isArray(condition.value)) return true;
      return !(condition.value as unknown[]).includes(actual);
    case "is_set":
      return actual !== null && actual !== undefined && actual !== "";
    case "is_empty":
      return actual === null || actual === undefined || actual === "";
    default:
      return true;
  }
}
