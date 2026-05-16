/**
 * cap-search capability definition.
 *
 * Wires the search-document store, the event-driven indexer, and the global
 * GraphQL `search` query. Indexes are passed in by the host or by other
 * capabilities — Phase 1 has no auto-discovery.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { buildSearchIndexRegistry, createSearchIndexer } from "./event-handler";
import { buildSearchGraphQLExtension } from "./graphql";
import { DrizzleSearchService, InMemorySearchService } from "./service";
import type { SearchIndexDefinition, SearchService } from "./types";

// ── Capability options ──────────────────────────────────────

export interface CapSearchOptions {
  /**
   * Drizzle database instance for persistent storage.
   * When omitted, falls back to in-memory storage (dev/test only).
   */
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB type varies by driver
  db?: any;
  /**
   * Pre-built SearchService instance. When provided, `db` is ignored.
   */
  service?: SearchService;
  /**
   * Search-index registrations contributed by this host or other capabilities.
   * Each entry is the output of `defineSearchIndex({ ... })`.
   */
  indexes?: readonly SearchIndexDefinition[];
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Create a fully-wired cap-search capability.
 *
 * @example
 * ```ts
 * import { createCapSearch, defineSearchIndex } from "@linchkit/cap-search"
 *
 * const capSearch = createCapSearch({
 *   db,
 *   indexes: [
 *     defineSearchIndex({ entity: "purchase_request", fields: ["title", "description"] }),
 *   ],
 * })
 * ```
 */
export function createCapSearch(options?: CapSearchOptions): CapabilityDefinition & {
  searchService: SearchService;
} {
  const service: SearchService =
    options?.service ??
    (options?.db ? new DrizzleSearchService(options.db) : new InMemorySearchService());

  const registry = buildSearchIndexRegistry(options?.indexes ?? []);
  const indexer = createSearchIndexer({ indexes: registry, service });

  const capability = defineCapability({
    name: "cap-search",
    label: "Search",
    description:
      "Full-text search backed by PostgreSQL tsvector/tsquery. " +
      "Capabilities register entities via defineSearchIndex(); the indexer keeps " +
      "_linchkit.search_documents in sync via record.* events.",
    type: "standard",
    category: "system",
    version: "0.0.1",
    group: "search",

    eventHandlers: [indexer],

    extensions: {
      services: [
        {
          name: "search",
          factory: () => service,
        },
      ],
      graphqlExtensions: buildSearchGraphQLExtension({ service }),
    },
  });

  return Object.assign(capability, { searchService: service });
}

/** Static (no-DB, no-indexes) capability export for shape-only consumers. */
export const capSearch = createCapSearch();
