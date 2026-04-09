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
  const rawMinHitRate = options?.minHitRate ?? 0;
  if (!Number.isFinite(rawMinHitRate) || rawMinHitRate < 0 || rawMinHitRate > 1) {
    throw new RangeError("minHitRate must be a finite number between 0 and 1");
  }
  const minHitRate = rawMinHitRate;
  const probeKeyPrefix = options?.probeKey ?? "__health_probe__";

  return (): HealthCheckResult => {
    const start = Date.now();

    // Snapshot stats BEFORE probe to avoid contaminating hit-rate signal
    const stats = cacheManager.getStats();

    // Operational check: set + get a unique probe value
    const probeKey = `${probeKeyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const probeValue = `probe_${Date.now()}`;
    try {
      cacheManager.set(probeKey, probeValue, { ttl: 5000 });
      const retrieved = cacheManager.get<string>(probeKey);

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
    } finally {
      cacheManager.delete(probeKey);
    }

    // Stats-based checks (using pre-probe snapshot)
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
