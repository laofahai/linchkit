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
 * Wrap a plain string into the JSONB locale-map format.
 *
 * Example: wrapTranslatableValue("Hello", "en") → { "en": "Hello" }
 */
export function wrapTranslatableValue(value: string, locale: string): TranslatableValue {
  return { [locale]: value };
}

/**
 * Merge a new translation into an existing locale map.
 *
 * If `existing` is null/undefined, creates a new map with just the given locale.
 * If the locale already exists, it is overwritten.
 *
 * Example: mergeTranslatableValue({ "en": "Hello" }, "你好", "zh-CN")
 *        → { "en": "Hello", "zh-CN": "你好" }
 */
export function mergeTranslatableValue(
  existing: TranslatableValue | null | undefined,
  value: string,
  locale: string,
): TranslatableValue {
  return { ...(existing ?? {}), [locale]: value };
}

/**
 * Create a TranslatableValue from a translations object.
 *
 * Convenience factory — validates that the input has at least one entry.
 *
 * Example: createTranslatableValue({ en: "Hello", "zh-CN": "你好" })
 */
export function createTranslatableValue(translations: Record<string, string>): TranslatableValue {
  return { ...translations };
}

/**
 * Resolve a translation for the given locale from a TranslatableValue.
 *
 * This is an alias for `resolveTranslatableValue` with a friendlier name.
 *
 * Fallback chain:
 * 1. Exact locale match
 * 2. Language prefix match
 * 3. Default locale (fallback parameter)
 * 4. First available value
 * 5. Empty string if nothing found
 */
export function resolveTranslation(
  value: TranslatableValue,
  locale: string,
  fallback?: string,
): string {
  return resolveTranslatableValue(value, locale, fallback) ?? "";
}

/** Field types that support the `translatable` flag */
export const TRANSLATABLE_FIELD_TYPES = new Set(["string", "text", "enum"]);

/**
 * Validate that a schema's translatable fields are correctly configured.
 *
 * Rules:
 * - Only string, text, and enum fields can have `translatable: true`
 * - If any field is translatable, the schema should have `i18n.defaultLocale`
 *
 * Returns an array of validation error messages (empty = valid).
 */
export function validateTranslatableSchema(schema: SchemaDefinition): string[] {
  const errors: string[] = [];

  const hasTranslatable = Object.entries(schema.fields).some(
    ([_, field]) => (field as FieldDefinition).translatable,
  );

  for (const [name, field] of Object.entries(schema.fields)) {
    const f = field as FieldDefinition;
    if (f.translatable && !TRANSLATABLE_FIELD_TYPES.has(f.type)) {
      errors.push(
        `Field "${name}" (type: ${f.type}) cannot be translatable. Only string, text, and enum fields support translatable.`,
      );
    }
  }

  if (hasTranslatable && !schema.i18n?.defaultLocale) {
    errors.push(
      "Schema has translatable fields but no i18n.defaultLocale configured. Add i18n: { defaultLocale: '...' } to the schema definition.",
    );
  }

  return errors;
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

/**
 * Resolve all translatable fields in a data row from JSONB to plain strings.
 *
 * This is the read-path helper: given a raw DB row, replace every translatable
 * field's JSONB value with the resolved string for the requested locale.
 *
 * Non-translatable fields and fields not present in the row are left untouched.
 * Returns a shallow copy of the row with resolved values.
 */
export function resolveTranslatableRow(
  row: Record<string, unknown>,
  schema: SchemaDefinition,
  locale?: string,
): Record<string, unknown> {
  const translatableFields = getTranslatableFields(schema);
  if (translatableFields.size === 0) return row;

  const defaultLocale = schema.i18n?.defaultLocale;
  const resolved = { ...row };

  for (const fieldName of translatableFields) {
    if (fieldName in resolved) {
      resolved[fieldName] = resolveTranslatableValue(resolved[fieldName], locale, defaultLocale);
    }
  }

  return resolved;
}

/**
 * Normalize all translatable fields in a data row for storage.
 *
 * This is the write-path helper: given user-supplied data, ensure every
 * translatable field's value is in JSONB locale-map format.
 *
 * - Plain strings are wrapped as `{ [locale]: value }`.
 * - Objects are passed through (assumed to be locale maps already).
 * - Non-translatable fields are left untouched.
 *
 * Returns a shallow copy of the row with normalized values.
 */
export function normalizeTranslatableRow(
  row: Record<string, unknown>,
  schema: SchemaDefinition,
  locale?: string,
): Record<string, unknown> {
  const translatableFields = getTranslatableFields(schema);
  if (translatableFields.size === 0) return row;

  const effectiveLocale = locale ?? schema.i18n?.defaultLocale ?? "en";
  const normalized = { ...row };

  for (const fieldName of translatableFields) {
    if (fieldName in normalized) {
      normalized[fieldName] = normalizeTranslatableValue(normalized[fieldName], effectiveLocale);
    }
  }

  return normalized;
}
