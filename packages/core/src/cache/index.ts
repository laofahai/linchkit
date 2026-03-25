/**
 * Cache module — L1 in-process cache with LRU/TTL, multi-layer coordination
 *
 * See spec: docs/specs/34_cache_strategy.md
 */

export { CacheManager, type CacheManagerOptions, type NamespacedCache } from "./cache-manager";
export type { CacheEntry, CacheProvider, CacheSetOptions, CacheStats } from "./cache-provider";
export { type InMemoryCacheOptions, InMemoryCacheProvider } from "./in-memory-cache";
