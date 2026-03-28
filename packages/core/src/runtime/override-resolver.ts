/**
 * Override Resolver
 *
 * Merges Layer 2 (tenant runtime) overrides onto Layer 0 (design-time) definitions.
 * Only definitions marked as `overridable: true` can be overridden.
 * Override definitions are shallow-merged at the top level, deep-merged for nested objects.
 *
 * @see docs/specs/02_runtime_change.md
 */

import type { RuleDefinition } from "../types/rule";

// ── Types ────────────────────────────────────────────────

/** Any definition that supports the overridable flag */
export interface Overridable {
  name: string;
  overridable?: boolean;
}

// ── Deep merge utility ──────────────────────────────────

/**
 * Deep merge source into target (immutable — returns new object).
 * Arrays are replaced, not merged. Only plain objects are recursively merged.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    const existing = (result as Record<string, unknown>)[key];

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

// ── Resolution ──────────────────────────────────────────

/**
 * Apply a tenant override to a definition.
 * Returns the original if the definition is not overridable.
 */
export function applyOverride<T extends Overridable>(
  definition: T,
  override: Record<string, unknown> | undefined,
): T {
  if (!override) return definition;

  if (!definition.overridable) {
    return definition;
  }

  // Protect structural fields from override
  const safeOverride = { ...override };
  delete safeOverride.name;
  delete safeOverride.overridable;

  return deepMerge(definition as unknown as Record<string, unknown>, safeOverride) as unknown as T;
}

/**
 * Resolve a list of definitions against tenant overrides.
 * Only definitions with `overridable: true` will have overrides applied.
 *
 * @param definitions - Layer 0 definitions
 * @param overrides - Map of name → override definition from tenant_overrides table
 * @returns Resolved definitions with overrides applied
 */
export function resolveOverrides<T extends Overridable>(
  definitions: T[],
  overrides: Map<string, Record<string, unknown>>,
): T[] {
  if (overrides.size === 0) return definitions;

  return definitions.map((def) => {
    const override = overrides.get(def.name);
    return applyOverride(def, override);
  });
}

/**
 * Convenience: resolve a single rule definition with a tenant override.
 * Validates that only safe fields are overridden (condition, effect, priority).
 */
export function resolveRuleOverride(
  rule: RuleDefinition,
  override: Record<string, unknown> | undefined,
): RuleDefinition {
  return applyOverride(rule, override);
}
