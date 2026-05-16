/**
 * defineSearchIndex — declare which entity fields participate in full-text search.
 *
 * Capabilities call this once per entity they want indexable. Phase 1 keeps the
 * shape minimal: an entity name plus the list of fields whose values are
 * concatenated into the search document.
 *
 * @example
 * ```ts
 * import { defineSearchIndex } from "@linchkit/cap-search"
 *
 * export const purchaseRequestSearchIndex = defineSearchIndex({
 *   entity: "purchase_request",
 *   fields: ["title", "description", "vendor"],
 * })
 * ```
 */

import type { SearchIndexDefinition } from "./types";

export function defineSearchIndex(definition: SearchIndexDefinition): SearchIndexDefinition {
  if (!definition.entity || typeof definition.entity !== "string") {
    throw new Error("defineSearchIndex: `entity` must be a non-empty string");
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
    throw new Error(
      `defineSearchIndex(${definition.entity}): \`fields\` must be a non-empty string[]`,
    );
  }
  for (const field of definition.fields) {
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(
        `defineSearchIndex(${definition.entity}): every field name must be a non-empty string`,
      );
    }
  }
  return {
    entity: definition.entity,
    fields: [...definition.fields],
  };
}
