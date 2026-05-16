/**
 * useSearchClient — hook returning a typed `search(query)` callable.
 *
 * By default issues a GraphQL POST to `/graphql` using the cap-search
 * `search(q, entity, limit)` query and returns plain `SearchHit[]`.
 *
 * The callable is injectable via the `fetchFn` and `endpoint` options
 * so tests (and embedded preview environments) can supply a fake
 * transport without monkey-patching `globalThis.fetch`.
 *
 * Note on schema shape: the cap-search GraphQL extension returns
 * `{ entity, recordId, score }` per hit — there is intentionally no
 * `id`, `snippet`, or `rank` field on the wire (the Postgres ts_headline
 * snippet pipeline is not part of Phase 1). Consumers compose a stable
 * row key from `entity:recordId`; snippet text is rendered as the
 * record-id when no separate body is available.
 */

import { graphql } from "@linchkit/cap-adapter-ui/lib/api";
import { useMemo } from "react";

export interface SearchHit {
  /** snake_case entity name (e.g. "purchase_request"). */
  entity: string;
  /** Primary key of the matching record. */
  recordId: string;
  /** PostgreSQL ts_rank score (higher = better match); 0 for in-memory fallback. */
  score: number;
}

export interface SearchClient {
  search(query: string, options?: { limit?: number; entity?: string }): Promise<SearchHit[]>;
}

/**
 * Internal — minimal GraphQL response shape so this hook does not
 * depend on the cap-adapter-ui api module at runtime when a custom
 * fetchFn is supplied.
 */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

const SEARCH_QUERY =
  "query Search($q: String!, $entity: String, $limit: Int) {\n" +
  "  search(q: $q, entity: $entity, limit: $limit) {\n" +
  "    entity\n" +
  "    recordId\n" +
  "    score\n" +
  "  }\n" +
  "}";

/** Low-level transport — accepts a GraphQL query + variables, returns a body. */
export type SearchTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphQLResponse<{ search: SearchHit[] }>>;

export interface UseSearchClientOptions {
  /**
   * Custom transport. Defaults to the adapter-ui `graphql()` client
   * which already carries `Authorization` + `X-Tenant-Id` headers.
   * Tests inject a fake to avoid spinning up a server.
   */
  transport?: SearchTransport;
}

/**
 * Hook returning a stable `SearchClient`. Re-renders never reissue
 * the network call; the `search` callable is memoized for the lifetime
 * of the component when options are unchanged.
 *
 * Auth/tenant headers come from `@linchkit/cap-adapter-ui/lib/api`'s
 * `graphql()` helper by default (Bearer token from localStorage +
 * `X-Tenant-Id`). Hosts wiring a different transport must add those
 * headers themselves; the search endpoint enforces tenant scoping
 * server-side.
 */
export function useSearchClient(options: UseSearchClientOptions = {}): SearchClient {
  const transport = options.transport;

  return useMemo<SearchClient>(
    () => ({
      async search(query, searchOptions) {
        const trimmed = query.trim();
        if (trimmed.length === 0) return [];

        const send: SearchTransport =
          transport ?? ((q, v) => graphql<{ search: SearchHit[] }>(q, v));

        const body = await send(SEARCH_QUERY, {
          q: trimmed,
          entity: searchOptions?.entity,
          limit: searchOptions?.limit ?? 20,
        });

        if (body.errors && body.errors.length > 0) {
          const first = body.errors.at(0);
          throw new Error(first?.message ?? "Search query failed");
        }

        const hits = body.data?.search ?? [];
        // Defensive copy with normalized score — protects downstream
        // components from receiving NaN if the server ever returns a
        // non-numeric value (defensive parity with DrizzleSearchService).
        return hits.map((hit) => ({
          entity: hit.entity,
          recordId: hit.recordId,
          score: Number(hit.score) || 0,
        }));
      },
    }),
    [transport],
  );
}
