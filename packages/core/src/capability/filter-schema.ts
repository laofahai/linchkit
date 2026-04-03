/**
 * Schema filtering based on available capabilities.
 *
 * When a field declares `requiresCapability`, it is only included
 * if that capability is present in the active capability set.
 * This enables runtime weak dependency degradation — optional
 * features gracefully disappear when their backing capability
 * is not installed.
 *
 * Integration points (to be wired later):
 * - Drizzle schema generation: skip DB columns for filtered fields
 * - GraphQL type generation: omit fields from object types
 * - UI form/list rendering: hide fields from AutoForm / AutoList
 */

import type { FieldDefinition, EntityDefinition } from "../types/schema";

/**
 * Filter schema fields based on available capabilities.
 * Returns a new EntityDefinition with fields removed whose
 * `requiresCapability` is not in the active capability set.
 *
 * The original schema is never mutated.
 */
export function filterSchemaByCapabilities<
  TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>,
>(schema: EntityDefinition<TFields>, activeCapabilities: Set<string>): EntityDefinition {
  const filteredFields: Record<string, FieldDefinition> = {};

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.requiresCapability && !activeCapabilities.has(field.requiresCapability)) {
      continue;
    }
    filteredFields[name] = field;
  }

  return {
    ...schema,
    fields: filteredFields,
  };
}
