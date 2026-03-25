/**
 * CacheProvider — Pluggable cache backend interface
 *
 * L1 = in-process (Map/LRU), L2 = distributed (Redis), L3 = Postgres (source of truth).
 * All providers implement this interface so the CacheManager can coordinate layers.
 *
 * See spec: docs/specs/34_cache_strategy.md
 */

// ── Cache entry metadata ──────────────────────────────────

export interface CacheEntry<T = unknown> {
  /** Cached value */
  value: T;
  /** Absolute expiry timestamp (ms since epoch). Undefined = no TTL. */
  expiresAt?: number;
  /** Tags for group invalidation (e.g. ["schema:purchase_request", "tenant:t1"]) */
  tags: string[];
  /** Timestamp when entry was created (ms since epoch) */
  createdAt: number;
}

// ── Options ───────────────────────────────────────────────

export interface CacheSetOptions {
  /** Time-to-live in milliseconds. Undefined = no expiry. */
  ttl?: number;
  /** Tags for group invalidation */
  tags?: string[];
}

// ── Cache stats ───────────────────────────────────────────

export interface CacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Total evictions (LRU or TTL) */
  evictions: number;
  /** Current number of entries */
  size: number;
  /** Hit rate (0..1) */
  hitRate: number;
}

// ── Provider interface ────────────────────────────────────

export interface CacheProvider {
  /** Retrieve a cached value. Returns undefined on miss or expired entry. */
  get<T = unknown>(key: string): T | undefined;

  /** Store a value with optional TTL and tags. */
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void;

  /** Delete a single key. Returns true if the key existed. */
  delete(key: string): boolean;

  /** Delete all keys that carry the given tag. Returns count of deleted keys. */
  invalidateByTag(tag: string): number;

  /** Delete all keys whose key string starts with the given prefix. */
  invalidateByPrefix(prefix: string): number;

  /** Remove all entries. */
  clear(): void;

  /** Return current stats snapshot. */
  stats(): CacheStats;
}
