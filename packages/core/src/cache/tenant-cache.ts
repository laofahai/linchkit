/**
 * Tenant-scoped cache namespace — prefixes keys with `{ns}:{tenantId}:`
 *
 * Wraps CacheManager.namespace() to provide tenant isolation for multi-tenant
 * caching. Keys are automatically prefixed so different tenants never collide.
 *
 * See spec: docs/specs/34_cache_strategy.md §3.2, §4, §5
 */

import type { CacheManager, NamespacedCache } from "./cache-manager";

/**
 * Create a tenant-scoped namespaced cache.
 *
 * The resulting NamespacedCache prefixes all keys with `{namespace}:{tenantId}:`.
 * For example, `createTenantNamespace(mgr, "query", "t1")` produces keys like
 * `query:t1:orders:abc123`.
 *
 * This allows efficient tenant-level invalidation via `invalidateAll()`,
 * which clears all keys with the `{namespace}:{tenantId}:` prefix.
 */
export function createTenantNamespace(
  manager: CacheManager,
  namespace: string,
  tenantId: string,
): NamespacedCache {
  const tenantNs = `${namespace}:${tenantId}`;
  return manager.namespace(tenantNs);
}
