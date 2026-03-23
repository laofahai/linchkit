/**
 * Translatable field helpers
 *
 * Handles locale resolution and value normalization for fields
 * with `translatable: true`. These fields are stored as JSONB
 * with structure `{ [locale]: value }`.
 */

import type { FieldDefinition, SchemaDefinition } from "../types/schema";

/** A locale-keyed map of translated values */
export type TranslatableValue = Record<string, string>;

/**
 * Resolve a translatable JSONB value to a single string for the requested locale.
 *
 * Fallback chain:
 * 1. Exact locale match (e.g., "zh-CN")
 * 2. Language prefix match (e.g., "zh" matches "zh-CN")
 * 3. Default locale
 * 4. First available value
 */
export function resolveTranslatableValue(
  value: unknown,
  locale?: string,
  defaultLocale?: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  // Plain string — return as-is (shouldn't happen in DB, but defensive)
  if (typeof value === "string") return value;

  // Must be an object (locale map)
  if (typeof value !== "object") return undefined;

  const map = value as Record<string, string>;
  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;

  // 1. Exact locale match
  if (locale && map[locale] !== undefined) {
    return map[locale];
  }

  // 2. Language prefix match (e.g., "zh" matches "zh-CN" or "zh-TW")
  if (locale) {
    const prefix = locale.split("-")[0];
    if (prefix) {
      const prefixMatch = keys.find((k) => k === prefix || k.split("-")[0] === prefix);
      if (prefixMatch && map[prefixMatch] !== undefined) {
        return map[prefixMatch];
      }
    }
  }

  // 3. Default locale
  if (defaultLocale && map[defaultLocale] !== undefined) {
    return map[defaultLocale];
  }

  // 4. First available value
  const firstKey = keys[0];
  return firstKey ? map[firstKey] : undefined;
}

/**
 * Normalize a translatable field value for storage.
 *
 * - If the value is already a locale map (object), pass through.
 * - If the value is a plain string, wrap as `{ [defaultLocale]: value }`.
 * - If the value is null/undefined, pass through.
 */
export function normalizeTranslatableValue(
  value: unknown,
  defaultLocale: string,
): TranslatableValue | null | undefined {
  if (value === null || value === undefined) return value as null | undefined;

  // Already a locale map
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as TranslatableValue;
  }

  // Plain string → wrap with default locale
  if (typeof value === "string") {
    return { [defaultLocale]: value };
  }

  // Unexpected type — return as-is (let validation catch it)
  return value as TranslatableValue;
}

/**
 * Get the set of translatable field names from a SchemaDefinition.
 */
export function getTranslatableFields(schema: SchemaDefinition): Set<string> {
  const result = new Set<string>();
  for (const [name, field] of Object.entries(schema.fields)) {
    if ((field as FieldDefinition).translatable) {
      result.add(name);
    }
  }
  return result;
}
