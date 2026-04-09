/**
 * CacheTtlPolicy — Per-namespace TTL configuration with optional SWR
 *
 * Allows declarative TTL assignment per cache namespace, matching the
 * spec-defined defaults (override: 5min+1min SWR, perm: 10min, query: 1min).
 *
 * See spec: docs/specs/34_cache_strategy.md §3.2, §4, §5
 */

// ── Types ────────────────────────────────────────────────

export interface CacheTtlPolicy {
  /** Namespace this policy applies to (exact match or prefix match with trailing `:`) */
  namespace: string;
  /** Time-to-live in milliseconds */
  ttl: number;
  /** Stale-while-revalidate window in milliseconds. Requires `ttl`. */
  swrTtl?: number;
}

// ── Resolved TTL result ──────────────────────────────────

export interface ResolvedTtl {
  ttl: number;
  swrTtl?: number;
}

// ── Default policies from spec ───────────────────────────

/**
 * Default TTL policies derived from Spec 34:
 * - `override` — Tenant overrides: 5 min TTL + 1 min SWR (§3.2)
 * - `perm` — Permission decisions: 10 min TTL (§4)
 * - `query` — GraphQL query results: 1 min TTL (§5)
 */
export const DEFAULT_TTL_POLICIES: CacheTtlPolicy[] = [
  { namespace: "override", ttl: 5 * 60 * 1000, swrTtl: 1 * 60 * 1000 },
  { namespace: "perm", ttl: 10 * 60 * 1000 },
  { namespace: "query", ttl: 1 * 60 * 1000 },
];

// ── Resolution ───────────────────────────────────────────

/**
 * Find the TTL policy that matches a given namespace.
 *
 * Matching strategy (first match wins):
 * 1. Exact match on namespace name
 * 2. Prefix match — policy namespace is a prefix of the target (e.g. policy "query" matches "query:tenant1")
 *
 * Policies are checked in array order, so more specific entries should appear first
 * if multiple policies could match the same namespace.
 */
export function resolveTtlForNamespace(
  ns: string,
  policies: CacheTtlPolicy[],
): ResolvedTtl | undefined {
  for (const policy of policies) {
    if (ns === policy.namespace || ns.startsWith(`${policy.namespace}:`)) {
      return {
        ttl: policy.ttl,
        swrTtl: policy.swrTtl,
      };
    }
  }
  return undefined;
}
