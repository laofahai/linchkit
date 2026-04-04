/**
 * Shared i18n types and utilities for LinchKit.
 *
 * This module provides:
 * - SupportedLanguage: common BCP 47 locale codes
 * - I18nConfig: per-schema i18n configuration type
 * - TranslatableValue: locale-keyed string map type
 * - Locale resolution helpers
 *
 * Translatable field helpers (resolveTranslatableRow, normalizeTranslatableRow, etc.)
 * are re-exported from schema/translatable for convenience.
 */

// ── Common locale types ─────────────────────────────────────────────────────

/**
 * Common BCP 47 locale codes.
 * Not exhaustive — any valid BCP 47 string is accepted at runtime.
 * This union provides IDE autocomplete for the most common locales.
 */
export type SupportedLanguage =
  | "en"
  | "en-US"
  | "en-GB"
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "fr"
  | "fr-FR"
  | "de"
  | "de-DE"
  | "es"
  | "es-ES"
  | "pt"
  | "pt-BR"
  | "ru"
  | "ar"
  | "it"
  | "nl"
  | (string & Record<never, never>); // allow arbitrary BCP 47 strings

// ── TranslatableValue type ──────────────────────────────────────────────────

/**
 * A locale-keyed map of translated string values.
 * Stored as JSONB in PostgreSQL; plain object in InMemoryStore.
 *
 * Example: { "en": "Purchase Order", "zh-CN": "采购订单" }
 */
export type TranslatableValue = Record<string, string>;

// ── I18n config types ───────────────────────────────────────────────────────

/**
 * Per-schema i18n configuration.
 * Placed on EntityDefinition.i18n when the schema has translatable fields.
 */
export interface I18nConfig {
  /** Default locale used when the requested locale has no translation */
  defaultLocale: string;
  /** Optional list of supported locales (informational — does not enforce) */
  supportedLocales?: string[];
}

// ── Locale resolution ───────────────────────────────────────────────────────

/**
 * Parse the primary locale from an Accept-Language HTTP header value.
 * Takes the first language tag before ',' or ';', normalizing whitespace.
 *
 * Examples:
 *   "zh-CN,en-US;q=0.9" → "zh-CN"
 *   "en-US;q=0.9"       → "en-US"
 *   ""                  → undefined
 */
export function parseAcceptLanguage(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(/[,;]/)[0]?.trim();
  return first || undefined;
}

/**
 * Resolve locale from multiple sources in priority order:
 * 1. Explicit locale parameter
 * 2. Accept-Language header
 * 3. Default locale fallback
 *
 * Returns undefined if no locale can be resolved.
 */
export function resolveLocale(options: {
  locale?: string;
  acceptLanguage?: string | null;
  defaultLocale?: string;
}): string | undefined {
  if (options.locale) return options.locale;
  const fromHeader = parseAcceptLanguage(options.acceptLanguage);
  if (fromHeader) return fromHeader;
  return options.defaultLocale;
}

// ── Re-exports from translatable helpers ────────────────────────────────────

export {
  createTranslatableValue,
  getTranslatableFields,
  I18N_RAW_KEY,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
  TRANSLATABLE_FIELD_TYPES,
  validateTranslatableEntity,
  wrapTranslatableValue,
} from "../entity/translatable";
