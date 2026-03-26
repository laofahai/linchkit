/**
 * AI Response Cache
 *
 * LRU cache for AI completion responses. Caches identical prompts
 * to avoid redundant API calls and reduce cost/latency.
 *
 * Cache key is derived from: provider + model + messages + temperature + responseFormat.
 * Tool-calling requests are never cached (non-deterministic tool interactions).
 *
 * See spec 36_ai_service.md §5 — cost control.
 */

import type { AICacheConfig, AICompletionOptions, AICompletionResult } from "../types/ai";

// ── Cache entry ─────────────────────────────────────────────

interface CacheEntry {
  result: AICompletionResult;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

// ── AIResponseCache ─────────────────────────────────────────

export class AIResponseCache {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly modelFilter?: Set<string>;

  constructor(config: AICacheConfig) {
    this.maxEntries = config.maxEntries ?? 1000;
    this.ttlMs = config.ttlMs ?? 3_600_000; // 1 hour
    this.modelFilter = config.modelFilter ? new Set(config.modelFilter) : undefined;
  }

  /**
   * Look up a cached response for the given completion options.
   * Returns undefined on cache miss.
   */
  get(options: AICompletionOptions): AICompletionResult | undefined {
    if (!this.isCacheable(options)) return undefined;

    const key = this.buildKey(options);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL expiration
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Update access stats (for LRU eviction)
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();

    // Return a copy with cached flag
    return { ...entry.result, cached: true };
  }

  /** Store a completion result in the cache */
  set(options: AICompletionOptions, result: AICompletionResult): void {
    if (!this.isCacheable(options)) return;

    // Evict if at capacity
    if (this.cache.size >= this.maxEntries) {
      this.evictLRU();
    }

    const key = this.buildKey(options);
    this.cache.set(key, {
      result: { ...result, cached: undefined },
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
    });
  }

  /** Clear all cached entries */
  clear(): void {
    this.cache.clear();
  }

  /** Get current cache size */
  get size(): number {
    return this.cache.size;
  }

  /** Get cache statistics */
  stats(): { size: number; maxEntries: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }

  // ── Private ─────────────────────────────────────────────

  /**
   * Check if a request is cacheable.
   * Tool-calling requests are never cached (non-deterministic).
   * Temperature > 0 requests are never cached (non-deterministic).
   */
  private isCacheable(options: AICompletionOptions): boolean {
    // Explicit cache opt-out
    if (options.cache === false) return false;

    // Tool calls are non-deterministic
    if (options.tools && options.tools.length > 0) return false;

    // Non-zero temperature is non-deterministic
    if (options.temperature && options.temperature > 0) return false;

    // Model filter check
    if (this.modelFilter && options.model) {
      if (!this.modelFilter.has(options.model)) return false;
    }

    return true;
  }

  /**
   * Build a deterministic cache key from completion options.
   * Includes: provider, model, messages, temperature, responseFormat type.
   */
  private buildKey(options: AICompletionOptions): string {
    const parts = [
      options.provider ?? "__default__",
      options.model ?? "__default__",
      options.tenantId ?? "__global__",
      String(options.temperature ?? 0),
      options.responseFormat?.type ?? "text",
      // Serialize messages for key
      JSON.stringify(
        options.messages.map((m) => ({
          r: m.role,
          c: m.content,
        })),
      ),
    ];
    return parts.join("|");
  }

  /** Evict the least recently used entry */
  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}
