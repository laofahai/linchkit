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

import { i18n } from "@linchkit/cap-adapter-ui";
import { graphql } from "@linchkit/cap-adapter-ui/lib/api";
import { useMemo } from "react";

/**
 * Resolve a translation key against the shared i18next instance, falling
 * back to the supplied string when the runtime has no matching bundle
 * (e.g. in a unit-test process that imports this module without booting
 * cap-adapter-ui's i18n init). Used for the rare error path where we can't
 * call `useTranslation()` because we're outside a React component.
 */
function tr(key: string, fallback: string): string {
  const result = i18n.t(key, { defaultValue: fallback });
  return typeof result === "string" ? result : fallback;
}

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

/** Default page size used when callers omit `limit` (matches SearchPanel default). */
const DEFAULT_LIMIT = 20;
/** Server-side hard cap on `limit` — keep this client mirror in sync with the resolver. */
const MAX_LIMIT = 200;
/** Server-side floor on `limit` — zero/negative is rejected upstream. */
const MIN_LIMIT = 1;

/**
 * Coerce a caller-supplied `limit` into a safe integer in `[MIN_LIMIT, MAX_LIMIT]`.
 *
 * - `undefined` / non-finite (NaN, ±Infinity) → `DEFAULT_LIMIT` (20)
 * - Non-integer → truncated via `Math.trunc` (matches Postgres bigint coercion)
 * - Below `MIN_LIMIT` → clamped up to 1
 * - Above `MAX_LIMIT` → clamped down to 200
 *
 * Pre-flight normalization avoids round-trip GraphQL errors for trivially
 * invalid values and mirrors the server clamp so the UI never surprises
 * users with a request that the resolver silently truncated.
 */
export function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  const truncated = Math.trunc(value);
  if (truncated < MIN_LIMIT) return MIN_LIMIT;
  if (truncated > MAX_LIMIT) return MAX_LIMIT;
  return truncated;
}

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
 * Build a `SearchClient` from a transport. Exported separately from the
 * hook so the wire contract can be tested without touching React (the
 * hook is just a `useMemo` wrapper around this factory).
 */
export function createSearchClient(transport?: SearchTransport): SearchClient {
  return {
    async search(query, searchOptions) {
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      const send: SearchTransport = transport ?? ((q, v) => graphql<{ search: SearchHit[] }>(q, v));

      const body = await send(SEARCH_QUERY, {
        q: trimmed,
        entity: searchOptions?.entity,
        limit: normalizeLimit(searchOptions?.limit),
      });

      if (body.errors && body.errors.length > 0) {
        const first = body.errors.at(0);
        throw new Error(first?.message ?? tr("search.errors.queryFailed", "Search query failed"));
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
  };
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
  return useMemo<SearchClient>(() => createSearchClient(transport), [transport]);
}
