/**
 * search.indexer — event-driven full-text indexer.
 *
 * Listens to record.created / record.updated / record.deleted and keeps the
 * `_linchkit.search_documents` table in sync for any entity that has a
 * registered `defineSearchIndex`. Phase 1 only indexes future writes; existing
 * rows must be backfilled via a separate job (tracked as a follow-up issue).
 */

import type { EventHandlerDefinition, EventRecord } from "@linchkit/core";
import { defineEventHandler } from "@linchkit/core";
import type { SearchIndexDefinition, SearchService } from "./types";

// ── Helpers ─────────────────────────────────────────────────

/** Stringify a single field value for indexing. Skips null/undefined and structured values. */
function fieldToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Drop arrays and objects — Phase 1 only indexes scalar fields. Capabilities
  // wanting to index nested data must precompute a flat string field.
  return "";
}

/** Build the search-document content string from an entity row. */
function buildContent(fields: string[], row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of fields) {
    const text = fieldToText(row[field]);
    if (text.length > 0) parts.push(text);
  }
  return parts.join(" ");
}

/** Pick the post-update payload, supporting both `_new` and `after` conventions. */
function extractAfter(event: EventRecord): Record<string, unknown> | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (payload._new && typeof payload._new === "object") {
    return payload._new as Record<string, unknown>;
  }
  if (payload.after && typeof payload.after === "object") {
    return payload.after as Record<string, unknown>;
  }
  // Fall back to the payload itself if neither convention is present (some
  // emitters put the new record at the top level).
  return undefined;
}

// ── Event handler factory ───────────────────────────────────

export interface SearchIndexerOptions {
  /** Search-index registry keyed by entity name */
  indexes: ReadonlyMap<string, SearchIndexDefinition>;
  /** Storage backend (Drizzle in production, in-memory in tests) */
  service: SearchService;
}

export function createSearchIndexer(options: SearchIndexerOptions): EventHandlerDefinition {
  const { indexes, service } = options;

  return defineEventHandler({
    name: "search.indexer",
    label: "Full-text search indexer",
    description:
      "Updates `_linchkit.search_documents` whenever a record with a registered " +
      "search index is created, updated, or deleted.",

    listen: ["record.created", "record.updated", "record.deleted"],

    async handler(event, _ctx) {
      const entity = event.entity ?? (event.payload.entity as string | undefined);
      const recordId = event.recordId ?? (event.payload.recordId as string | undefined);
      if (!entity || !recordId) return;

      const indexDef = indexes.get(entity);
      if (!indexDef) return; // entity not registered for search — ignore

      const tenantId = event.tenantId;

      if (event.type === "record.deleted") {
        await service.deleteDocument({ tenantId, entity, recordId });
        return;
      }

      const after = extractAfter(event);
      if (!after) return;

      const content = buildContent(indexDef.fields, after);
      if (content.length === 0) {
        // Nothing indexable in the row; remove any stale document.
        await service.deleteDocument({ tenantId, entity, recordId });
        return;
      }

      await service.upsertDocument({ tenantId, entity, recordId, content });
    },
  });
}

// ── Registry helper ─────────────────────────────────────────

/**
 * Build a Map<entity, SearchIndexDefinition> from a list. Throws on duplicates
 * so two capabilities cannot silently fight over the same entity's fields.
 */
export function buildSearchIndexRegistry(
  defs: readonly SearchIndexDefinition[],
): Map<string, SearchIndexDefinition> {
  const map = new Map<string, SearchIndexDefinition>();
  for (const def of defs) {
    if (map.has(def.entity)) {
      throw new Error(
        `cap-search: duplicate defineSearchIndex registration for entity "${def.entity}"`,
      );
    }
    map.set(def.entity, def);
  }
  return map;
}
