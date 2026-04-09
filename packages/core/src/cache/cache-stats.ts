/**
 * Cache diagnostics types — comprehensive stats for monitoring and health checks.
 *
 * See spec: docs/specs/34_cache_strategy.md §9
 */

import type { CacheStats } from "./cache-provider";

// ── Stats types ──────────────────────────────────────────

export interface CacheManagerStats {
  /** Total entries across all layers */
  totalEntries: number;
  /** Total cache hits (L1 + L2) */
  hits: number;
  /** Manager-level misses (final-layer miss count, not L1+L2 sum) */
  misses: number;
  /** Hit rate as a ratio 0..1 */
  hitRate: number;
  /** Total evictions across all layers */
  evictions: number;
  /** Estimated memory usage in bytes (entries * avgEntrySize) */
  estimatedMemoryBytes: number;
  /** Per-namespace entry counts (namespace prefix → count) */
  namespaces: Record<string, number>;
  /** Raw L1 stats */
  l1: CacheStats;
  /** Raw L2 stats (if L2 is configured) */
  l2?: CacheStats;
}

export interface CacheManagerStatsOptions {
  /** Assumed average entry size in bytes for memory estimation. Default: 256 */
  avgEntrySizeBytes?: number;
}
