/**
 * InMemoryCacheProvider — L1 process-local cache with LRU eviction, TTL, and SWR
 *
 * Uses a Map (insertion-ordered) for O(1) get/set with LRU semantics:
 * on access, the entry is deleted and re-inserted to move it to the tail.
 * Eviction removes from the head (oldest / least-recently-used).
 *
 * Supports stale-while-revalidate (SWR): after soft TTL expires but before
 * hard TTL (softTtl + swrTtl), the value is served stale so callers can
 * revalidate in the background without blocking.
 *
 * See spec: docs/specs/34_cache_strategy.md §2 (L1), §3.2 (SWR for tenant overrides)
 */

import type { CacheEntry, CacheProvider, CacheSetOptions, CacheStats } from "./cache-provider";

export interface InMemoryCacheOptions {
  /** Maximum number of entries before LRU eviction kicks in. Default: 1000 */
  maxSize?: number;
}

export class InMemoryCacheProvider implements CacheProvider {
  private store = new Map<string, CacheEntry>();
  /** tag → set of keys that carry the tag */
  private tagIndex = new Map<string, Set<string>>();
  private maxSize: number;

  // Stats counters
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options?: InMemoryCacheOptions) {
    this.maxSize = options?.maxSize ?? 1000;
  }

  // ── get ─────────────────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    return this.getWithStaleness<T>(key)?.value;
  }

  /**
   * Retrieve a value with staleness metadata.
   * Returns `{ value, isStale: true }` when in the SWR window (soft-expired but still alive).
   * Returns undefined on hard expiry or miss.
   */
  getWithStaleness<T = unknown>(key: string): { value: T; isStale: boolean } | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      this._misses++;
      return undefined;
    }

    const now = Date.now();

    // Hard expiry check — evict and count as miss
    if (entry.expiresAt !== undefined && now > entry.expiresAt) {
      this.removeEntry(key, entry);
      this._misses++;
      return undefined;
    }

    // LRU: move to tail
    this.store.delete(key);
    this.store.set(key, entry);

    this._hits++;

    // Stale check: within SWR window if past softExpiresAt but not yet hardExpiresAt
    const isStale = entry.softExpiresAt !== undefined && now > entry.softExpiresAt;

    return { value: entry.value as T, isStale };
  }

  // ── set ─────────────────────────────────────────────────

  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void {
    // If key already exists, remove old tag references
    const existing = this.store.get(key);
    if (existing) {
      this.unindexTags(key, existing.tags);
      this.store.delete(key); // delete so re-insert goes to tail
    }

    const tags = options?.tags ?? [];
    const now = Date.now();

    let softExpiresAt: number | undefined;
    let hardExpiresAt: number | undefined;

    if (options?.ttl !== undefined) {
      if (options.swrTtl !== undefined) {
        // SWR mode: soft expiry at ttl, hard eviction at ttl + swrTtl
        softExpiresAt = now + options.ttl;
        hardExpiresAt = now + options.ttl + options.swrTtl;
      } else {
        // Normal TTL: hard eviction at ttl
        hardExpiresAt = now + options.ttl;
      }
    }

    const entry: CacheEntry = {
      value,
      expiresAt: hardExpiresAt,
      softExpiresAt,
      tags,
      createdAt: now,
    };

    this.store.set(key, entry);
    this.indexTags(key, tags);

    // Evict LRU if over capacity
    this.evictIfNeeded();
  }

  // ── delete ──────────────────────────────────────────────

  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.removeEntry(key, entry);
    return true;
  }

  // ── invalidateByTag ─────────────────────────────────────

  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;

    let count = 0;
    // Copy to array to avoid mutation during iteration
    for (const key of [...keys]) {
      const entry = this.store.get(key);
      if (entry) {
        this.removeEntry(key, entry);
        count++;
      }
    }
    return count;
  }

  // ── invalidateByPrefix ──────────────────────────────────

  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        this.removeEntry(key, entry);
        count++;
      }
    }
    return count;
  }

  // ── clear ───────────────────────────────────────────────

  clear(): void {
    this.store.clear();
    this.tagIndex.clear();
  }

  // ── stats ───────────────────────────────────────────────

  stats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: this.store.size,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /** Return all current cache keys (for diagnostics). */
  keys(): string[] {
    return Array.from(this.store.keys());
  }

  // ── Internal helpers ────────────────────────────────────

  private removeEntry(key: string, entry: CacheEntry): void {
    this.store.delete(key);
    this.unindexTags(key, entry.tags);
  }

  private indexTags(key: string, tags: string[]): void {
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  private unindexTags(key: string, tags: string[]): void {
    for (const tag of tags) {
      const set = this.tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.tagIndex.delete(tag);
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      // Map iterator yields in insertion order — first entry is LRU
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const entry = this.store.get(key);
      if (entry) this.removeEntry(key, entry);
      this._evictions++;
    }
  }
}
