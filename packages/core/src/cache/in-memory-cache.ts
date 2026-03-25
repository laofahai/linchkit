/**
 * InMemoryCacheProvider — L1 process-local cache with LRU eviction and TTL
 *
 * Uses a Map (insertion-ordered) for O(1) get/set with LRU semantics:
 * on access, the entry is deleted and re-inserted to move it to the tail.
 * Eviction removes from the head (oldest / least-recently-used).
 *
 * See spec: docs/specs/34_cache_strategy.md §2 (L1)
 */

import type { CacheEntry, CacheProvider, CacheSetOptions, CacheStats } from "./cache-provider";

export interface InMemoryCacheOptions {
  /** Maximum number of entries before LRU eviction kicks in. Default: 1000 */
  maxSize?: number;
  /** If true, run a passive cleanup sweep on every `get` for expired entries. Default: false */
  sweepOnGet?: boolean;
}

export class InMemoryCacheProvider implements CacheProvider {
  private store = new Map<string, CacheEntry>();
  /** tag → set of keys that carry the tag */
  private tagIndex = new Map<string, Set<string>>();
  private maxSize: number;
  private sweepOnGet: boolean;

  // Stats counters
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options?: InMemoryCacheOptions) {
    this.maxSize = options?.maxSize ?? 1000;
    this.sweepOnGet = options?.sweepOnGet ?? false;
  }

  // ── get ─────────────────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      this._misses++;
      return undefined;
    }

    // TTL check
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.removeEntry(key, entry);
      this._misses++;
      return undefined;
    }

    // LRU: move to tail
    this.store.delete(key);
    this.store.set(key, entry);

    this._hits++;
    return entry.value as T;
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
    const entry: CacheEntry = {
      value,
      expiresAt: options?.ttl !== undefined ? Date.now() + options.ttl : undefined,
      tags,
      createdAt: Date.now(),
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
