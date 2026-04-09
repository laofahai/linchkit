/**
 * Cache health check — integrates CacheManager diagnostics with HealthCheckRegistry.
 *
 * Verifies that L1 is operational (can set/get a probe key) and optionally
 * checks that the hit rate is above a configurable threshold.
 *
 * See spec: docs/specs/34_cache_strategy.md §9
 */

import type { HealthCheckFn, HealthCheckResult } from "../deployment/health-check";
import type { CacheManager } from "./cache-manager";

// ── Options ──────────────────────────────────────────────

export interface CacheHealthCheckOptions {
  /** Minimum acceptable hit rate (0..1). Below this → degraded. Default: 0 (disabled) */
  minHitRate?: number;
  /** Probe key used for operational check. Default: "__health_probe__" */
  probeKey?: string;
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create a health check function for the cache subsystem.
 *
 * The check performs two verifications:
 * 1. **Operational check**: writes and reads a probe key to confirm L1 works.
 * 2. **Hit rate check** (optional): flags "degraded" if hit rate falls below threshold.
 *
 * Compatible with HealthCheckRegistry.register().
 */
export function createCacheHealthCheck(
  cacheManager: CacheManager,
  options?: CacheHealthCheckOptions,
): HealthCheckFn {
  const minHitRate = options?.minHitRate ?? 0;
  const probeKey = options?.probeKey ?? "__health_probe__";

  return (): HealthCheckResult => {
    const start = Date.now();

    // Operational check: set + get a probe value
    const probeValue = `probe_${Date.now()}`;
    try {
      cacheManager.set(probeKey, probeValue, { ttl: 5000 });
      const retrieved = cacheManager.get<string>(probeKey);
      // Clean up probe key
      cacheManager.delete(probeKey);

      if (retrieved !== probeValue) {
        return {
          name: "cache",
          status: "unhealthy",
          message: `Operational check failed: expected "${probeValue}", got "${retrieved}"`,
          durationMs: Date.now() - start,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name: "cache",
        status: "unhealthy",
        message: `Operational check threw: ${msg}`,
        durationMs: Date.now() - start,
      };
    }

    // Stats-based checks
    const stats = cacheManager.getStats();
    const totalRequests = stats.hits + stats.misses;

    // Hit rate check (only meaningful after some traffic)
    if (minHitRate > 0 && totalRequests > 0 && stats.hitRate < minHitRate) {
      return {
        name: "cache",
        status: "degraded",
        message: `Hit rate ${(stats.hitRate * 100).toFixed(1)}% below threshold ${(minHitRate * 100).toFixed(1)}%`,
        durationMs: Date.now() - start,
        metadata: {
          hitRate: stats.hitRate,
          minHitRate,
          totalEntries: stats.totalEntries,
          hits: stats.hits,
          misses: stats.misses,
          evictions: stats.evictions,
        },
      };
    }

    return {
      name: "cache",
      status: "healthy",
      message: `${stats.totalEntries} entries, hit rate ${(stats.hitRate * 100).toFixed(1)}%`,
      durationMs: Date.now() - start,
      metadata: {
        hitRate: stats.hitRate,
        totalEntries: stats.totalEntries,
        hits: stats.hits,
        misses: stats.misses,
        evictions: stats.evictions,
        estimatedMemoryBytes: stats.estimatedMemoryBytes,
        namespaces: stats.namespaces,
      },
    };
  };
}
