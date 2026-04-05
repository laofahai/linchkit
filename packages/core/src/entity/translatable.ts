/**
 * Translatable field helpers
 *
 * Handles locale resolution and value normalization for fields
 * with `translatable: true`. These fields are stored as JSONB
 * with structure `{ [locale]: value }`.
 */

import type { EntityDefinition, FieldDefinition } from "../types/entity";

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
 * - If the value is a JSON-encoded locale map string (starts with "{"), parse it.
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

  // String — could be a JSON-encoded locale map or a plain string
  if (typeof value === "string") {
    // Try parsing JSON-encoded locale maps (e.g. '{"en":"Hello","zh-CN":"你好"}')
    if (value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          // Validate all values are strings (locale map shape)
          const entries = Object.entries(parsed);
          if (entries.length > 0 && entries.every(([_, v]) => typeof v === "string")) {
            return parsed as TranslatableValue;
          }
        }
      } catch {
        // Not valid JSON — fall through to plain string wrapping
      }
    }
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
export function validateTranslatableEntity(schema: EntityDefinition): string[] {
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
 * Get the set of translatable field names from a EntityDefinition.
 */
export function getTranslatableFields(schema: EntityDefinition): Set<string> {
  const result = new Set<string>();
  for (const [name, field] of Object.entries(schema.fields)) {
    if ((field as FieldDefinition).translatable) {
      result.add(name);
    }
  }
  return result;
}

/**
 * Hidden property key used to stash the raw JSONB locale maps on a resolved row.
 * GraphQL `_i18n` field resolvers read from this to return the full locale map
 * even after the main field has been resolved to a single-locale string.
 */
export const I18N_RAW_KEY = "__i18n_raw__";

/**
 * Resolve all translatable fields in a data row from JSONB to plain strings.
 *
 * This is the read-path helper: given a raw DB row, replace every translatable
 * field's JSONB value with the resolved string for the requested locale.
 *
 * Non-translatable fields and fields not present in the row are left untouched.
 * Returns a shallow copy of the row with resolved values.
 *
 * The original JSONB locale maps are preserved under `I18N_RAW_KEY` so that
 * downstream resolvers (e.g., GraphQL `_i18n` fields) can still access them.
 */
export function resolveTranslatableRow(
  row: Record<string, unknown>,
  schema: EntityDefinition,
  locale?: string,
): Record<string, unknown> {
  const translatableFields = getTranslatableFields(schema);
  if (translatableFields.size === 0) return row;

  const defaultLocale = schema.i18n?.defaultLocale;
  const resolved = { ...row };
  const rawMap: Record<string, unknown> = {};

  for (const fieldName of translatableFields) {
    if (fieldName in resolved) {
      const raw = resolved[fieldName];
      // Preserve the raw JSONB locale map before resolving
      if (raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw)) {
        rawMap[fieldName] = raw;
      }
      resolved[fieldName] = resolveTranslatableValue(raw, locale, defaultLocale);
    }
  }

  // Stash raw locale maps for `_i18n` field resolvers
  if (Object.keys(rawMap).length > 0) {
    resolved[I18N_RAW_KEY] = rawMap;
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
  schema: EntityDefinition,
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
