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

/**
 * Keys the CRUD emitters add at the top level alongside the spread record
 * fields. Strip them so the indexer only sees real entity columns.
 *
 * `record.created` payload shape (build-crud-actions.ts):
 *     { schema, recordId, ...result }
 * `record.updated` shape:
 *     { schema, recordId, _old, _new, changedFields }
 * `record.deleted` shape:
 *     { schema, recordId, id }   // no record body
 */
const CRUD_PAYLOAD_OVERHEAD_KEYS = new Set([
  "schema",
  "entity",
  "recordId",
  "id",
  "_old",
  "_new",
  "changedFields",
  "after",
  "before",
]);

function omitOverhead(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (CRUD_PAYLOAD_OVERHEAD_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Pick the post-write record body for indexing.
 *
 * For `record.created`, the built-in CRUD action spreads the new record at
 * the top level (`{ schema, recordId, ...result }`), so the body IS the
 * payload (minus the overhead keys above).
 *
 * For `record.updated`, the body is `_new` (full updated record).
 *
 * Other emitters that follow the `_new` / `after` convention also work.
 */
function extractAfter(event: EventRecord): Record<string, unknown> | undefined {
  const payload = event.payload as Record<string, unknown>;
  if (payload._new && typeof payload._new === "object") {
    return payload._new as Record<string, unknown>;
  }
  if (payload.after && typeof payload.after === "object") {
    return payload.after as Record<string, unknown>;
  }
  // Default for record.created (and any other emitter that puts the record
  // at the top level): treat the payload itself as the record body, with
  // CRUD overhead keys removed.
  const stripped = omitOverhead(payload);
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

/**
 * Resolve the entity name from an event. The action engine only promotes
 * `payload.entity` into `event.entity`, but the built-in CRUD emitters
 * use `payload.schema` instead, so we have to fall back through both.
 */
function resolveEntity(event: EventRecord): string | undefined {
  if (event.entity) return event.entity;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.entity === "string" && payload.entity) return payload.entity;
  if (typeof payload.schema === "string" && payload.schema) return payload.schema;
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
      const entity = resolveEntity(event);
      const payload = event.payload as Record<string, unknown>;
      const recordId =
        event.recordId ??
        (typeof payload.recordId === "string" ? payload.recordId : undefined) ??
        (typeof payload.id === "string" ? payload.id : undefined);
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
