/**
 * cap-cache-redis — Redis-backed L2 cache + cross-instance invalidation.
 *
 * Plug the provider returned by `createRedisCacheProvider()` into
 * `CacheManager`'s `l2` slot and pair it with the in-process L1 of your
 * choice. The capability itself only exposes a `services` registration so
 * downstream hosts can discover the provider via the standard DI lookup;
 * actual mounting into CacheManager remains the host application's job
 * (Spec 34 §7 Phase 2).
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { createRedisCacheProvider, type RedisCacheProvider } from "./redis-cache-provider";
import type { RedisCacheProviderOptions } from "./types";

export interface CapCacheRedisOptions extends RedisCacheProviderOptions {
  /**
   * Pre-built provider instance. When supplied, the factory skips
   * constructing a new provider — useful for tests that pass a fully
   * mocked instance.
   */
  provider?: RedisCacheProvider;
}

/**
 * Build a fully-wired `cap-cache-redis` capability.
 *
 * @example
 * ```ts
 * import { CacheManager } from "@linchkit/core";
 * import { createCapCacheRedis } from "@linchkit/cap-cache-redis";
 *
 * const cap = createCapCacheRedis({ redisUrl: process.env.REDIS_URL });
 * const cacheManager = new CacheManager({ l2: cap.provider });
 * ```
 */
export function createCapCacheRedis(options: CapCacheRedisOptions = {}): CapabilityDefinition & {
  provider: RedisCacheProvider;
} {
  const provider = options.provider ?? createRedisCacheProvider(options);

  const capability = defineCapability({
    name: "cap-cache-redis",
    label: "Cache (Redis L2)",
    description:
      "Redis-backed L2 cache provider with Pub/Sub cross-instance invalidation. " +
      "Plug into CacheManager.l2 and pair with the in-process L1 of your choice.",
    type: "standard",
    category: "system",
    version: "0.1.0",
    group: "cache-redis",
    autoInstall: false,
    extensions: {
      services: [
        {
          name: "cacheRedisProvider",
          factory: () => provider,
        },
      ],
    },
  });

  return Object.assign(capability, { provider });
}

/** Static (no-config) capability export for shape-only consumers. */
export const capCacheRedis = createCapCacheRedis;
