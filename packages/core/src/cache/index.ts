/**
 * Cache module — L1 in-process cache with LRU/TTL, multi-layer coordination
 *
 * See spec: docs/specs/34_cache_strategy.md
 */

export { type CacheHealthCheckOptions, createCacheHealthCheck } from "./cache-health";
export { CacheManager, type CacheManagerOptions, type NamespacedCache } from "./cache-manager";
export type { CacheEntry, CacheProvider, CacheSetOptions, CacheStats } from "./cache-provider";
export type { CacheManagerStats, CacheManagerStatsOptions } from "./cache-stats";
export { type InMemoryCacheOptions, InMemoryCacheProvider } from "./in-memory-cache";
export {
  CACHE_INVALIDATION_CHANNEL,
  type CacheInvalidationPayload,
  PostgresCacheInvalidator,
  type PostgresCacheInvalidatorOptions,
} from "./postgres-invalidator";
