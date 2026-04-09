/**
 * Translatable field index generation helpers
 *
 * Generates DDL statements for PostgreSQL indexes on JSONB translatable fields.
 * Two index types are supported:
 * - Expression index: B-tree on a specific locale extraction `(field->>'locale')`
 * - GIN index: Covers all locales for containment queries
 *
 * These helpers produce DDL strings for use in Drizzle migrations or manual SQL.
 * Indexes are opt-in, not auto-created.
 */

import type { EntityDefinition } from "../types/entity";
import { getTranslatableFields } from "./translatable";

/**
 * Sanitize a locale string for use in SQL identifiers.
 * Replaces non-alphanumeric characters with underscores.
 */
function sanitizeLocale(locale: string): string {
  return locale.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Generate a B-tree expression index DDL for a specific locale extraction.
 *
 * Output: `CREATE INDEX idx_<table>_<field>_<locale_safe> ON <table> ((<field>->>'<locale>'))`
 *
 * This enables fast equality/range lookups on a single locale's value.
 */
export function generateExpressionIndex(
  tableName: string,
  fieldName: string,
  locale: string,
): string {
  const safeLoc = sanitizeLocale(locale);
  return `CREATE INDEX idx_${tableName}_${fieldName}_${safeLoc} ON ${tableName} ((${fieldName}->>'${locale}'))`;
}

/**
 * Generate a GIN index DDL for a JSONB translatable field.
 *
 * Output: `CREATE INDEX idx_<table>_<field>_gin ON <table> USING GIN (<field>)`
 *
 * This enables containment queries (`@>`) across all locales.
 */
export function generateGinIndex(tableName: string, fieldName: string): string {
  return `CREATE INDEX idx_${tableName}_${fieldName}_gin ON ${tableName} USING GIN (${fieldName})`;
}

/**
 * Generate all recommended indexes for translatable fields in an entity.
 *
 * For each translatable field:
 * - One expression index per supported locale (B-tree on `field->>'locale'`)
 * - One GIN index for cross-locale search
 *
 * Requires `i18n.supportedLocales` to be defined on the entity.
 * If `supportedLocales` is not set but `defaultLocale` is, only the
 * default locale gets an expression index (plus the GIN index).
 *
 * Returns an array of DDL strings.
 */
export function generateTranslatableIndexes(entity: EntityDefinition, tableName: string): string[] {
  const translatableFields = getTranslatableFields(entity);
  if (translatableFields.size === 0) return [];

  const locales: string[] = [...(entity.i18n?.supportedLocales ?? [])];
  // Fall back to defaultLocale only when supportedLocales is empty
  if (locales.length === 0 && entity.i18n?.defaultLocale) {
    locales.push(entity.i18n.defaultLocale);
  }

  const ddlStatements: string[] = [];

  for (const fieldName of translatableFields) {
    // Expression indexes per locale
    for (const locale of locales) {
      ddlStatements.push(generateExpressionIndex(tableName, fieldName, locale));
    }

    // GIN index for cross-locale search
    ddlStatements.push(generateGinIndex(tableName, fieldName));
  }

  return ddlStatements;
}
