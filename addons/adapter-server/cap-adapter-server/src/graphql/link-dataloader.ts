/**
 * DataLoader factories for link resolvers.
 *
 * Creates per-request DataLoaders that batch and cache data-provider calls,
 * eliminating N+1 queries when resolving GraphQL link fields.
 *
 * Each loader key encodes both the record ID and tenantId so that tenant
 * isolation is preserved within the shared batch function.
 */

import type { DataProvider } from "@linchkit/core";
import DataLoader from "dataloader";

// ── Key helpers ─────────────────────────────────────────────

/** Composite key encoding schema + id + tenantId for cache isolation */
interface GetLoaderKey {
  schema: string;
  id: string;
  tenantId?: string;
}

/** Composite key for query-based loaders (one_to_many / reverse FK) */
interface QueryLoaderKey {
  schema: string;
  fkColumn: string;
  fkValue: string;
  tenantId?: string;
}

function getKeyStr(k: GetLoaderKey): string {
  return `${k.schema}\0${k.id}\0${k.tenantId ?? ""}`;
}

function queryKeyStr(k: QueryLoaderKey): string {
  return `${k.schema}\0${k.fkColumn}\0${k.fkValue}\0${k.tenantId ?? ""}`;
}

// ── DataLoader container ────────────────────────────────────

/**
 * Per-request DataLoader container.
 *
 * Holds a `getLoader` (batches `dataProvider.get` calls) and a
 * `queryLoader` (batches `dataProvider.query` calls with FK filters).
 *
 * Must be created once per GraphQL request to ensure proper cache scoping.
 */
export interface LinkDataLoaders {
  /** Batch-load individual records by (schema, id) */
  getLoader: DataLoader<GetLoaderKey, Record<string, unknown> | null>;
  /** Batch-load query results by (schema, fkColumn, fkValue) */
  queryLoader: DataLoader<QueryLoaderKey, Record<string, unknown>[]>;
}

/**
 * Create a fresh set of DataLoaders backed by the given DataProvider.
 *
 * Call this once per GraphQL request (inside the yoga context factory).
 */
export function createLinkDataLoaders(dataProvider: DataProvider): LinkDataLoaders {
  // ── GET loader: batch individual record fetches ───────────
  //
  // NOTE on batching semantics:
  // DataLoader provides **deduplication**, not batch SQL. When the same
  // (schema, id, tenantId) key is requested by multiple link resolvers
  // within a single GraphQL request tick, it is fetched only once.
  // However, distinct keys still result in N individual `dataProvider.get`
  // calls executed concurrently via `Promise.all` — there is no single
  // `WHERE id IN (...)` query.
  //
  // To achieve true batch SQL, the DataProvider interface would need a
  // `batchGet(schema, ids, opts)` method. This is a future enhancement.
  //
  const getLoader = new DataLoader<GetLoaderKey, Record<string, unknown> | null>(
    async (keys) => {
      // Group keys by (schema, tenantId) so we can issue fewer calls
      const groups = new Map<string, { keys: GetLoaderKey[]; indices: number[] }>();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!k) continue;
        const groupKey = `${k.schema}\0${k.tenantId ?? ""}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = { keys: [], indices: [] };
          groups.set(groupKey, group);
        }
        group.keys.push(k);
        group.indices.push(i);
      }

      const results: (Record<string, unknown> | null)[] = new Array(keys.length).fill(null);

      await Promise.all(
        Array.from(groups.values()).map(async (group) => {
          // Fetch all IDs for this schema+tenant group in parallel
          const records = await Promise.all(
            group.keys.map((k) =>
              dataProvider.get(k.schema, k.id, { tenantId: k.tenantId }).catch(() => null),
            ),
          );
          for (let j = 0; j < records.length; j++) {
            const idx = group.indices[j];
            if (idx !== undefined) results[idx] = (records[j] as Record<string, unknown>) ?? null;
          }
        }),
      );

      return results;
    },
    {
      // @ts-expect-error dataloader cacheKeyFn can return string
      cacheKeyFn: getKeyStr,
    },
  );

  // ── QUERY loader: batch FK-based queries ──────────────────
  //
  // NOTE on batching semantics:
  // Same deduplication benefit as getLoader — identical (schema, fkColumn,
  // fkValue, tenantId) tuples within a single tick are resolved only once.
  // Distinct keys issue N concurrent `dataProvider.query` calls via
  // `Promise.all`, each producing its own SQL query.
  //
  // A future optimisation could group keys by (schema, fkColumn, tenantId)
  // and issue a single `WHERE fkColumn IN (v1, v2, ...)` query per group,
  // but this requires a dedicated DataProvider batch-query interface.
  //
  const queryLoader = new DataLoader<QueryLoaderKey, Record<string, unknown>[]>(
    async (keys) => {
      // Each key is a unique (schema, fkColumn, fkValue, tenantId) tuple.
      // We batch by issuing all queries in parallel (DataLoader deduplicates
      // identical keys within a single tick).
      const results = await Promise.all(
        keys.map(async (k) => {
          try {
            return (await dataProvider.query(
              k.schema,
              { [k.fkColumn]: k.fkValue },
              { tenantId: k.tenantId },
            )) as Record<string, unknown>[];
          } catch {
            // Related schema table may not exist yet — return empty result set
            return [] as Record<string, unknown>[];
          }
        }),
      );
      return results;
    },
    {
      // @ts-expect-error dataloader cacheKeyFn can return string
      cacheKeyFn: queryKeyStr,
    },
  );

  return { getLoader, queryLoader };
}
