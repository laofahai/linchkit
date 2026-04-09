/**
 * CacheManager — Multi-layer cache coordinator with namespace support
 *
 * Coordinates L1 (in-process) and optional L2 (distributed) cache layers.
 * Provides namespaced access, tag-based invalidation, and event-driven
 * cache invalidation when connected to an EventBus.
 *
 * See spec: docs/specs/34_cache_strategy.md §8 (invalidation flow)
 */

import type { EventBus } from "../event/event-bus";
import type { EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import type { CacheProvider, CacheSetOptions, CacheStats } from "./cache-provider";
import type { CacheManagerStats, CacheManagerStatsOptions } from "./cache-stats";
import type { CacheTtlPolicy } from "./cache-ttl-policy";
import { resolveTtlForNamespace } from "./cache-ttl-policy";
import { InMemoryCacheProvider } from "./in-memory-cache";

// ── Configuration ─────────────────────────────────────────

export interface CacheManagerOptions {
  /** L1 in-process cache. Defaults to InMemoryCacheProvider(). */
  l1?: CacheProvider;
  /** Optional L2 distributed cache (e.g. Redis adapter). */
  l2?: CacheProvider;
  /** EventBus for event-driven invalidation. Optional. */
  eventBus?: EventBus;
  /** Logger. Optional. */
  logger?: Logger;
  /** Default TTL in ms when none is specified on set(). Undefined = no default TTL. */
  defaultTtl?: number;
  /** Per-namespace TTL policies. Auto-applied when set() has no explicit TTL. */
  ttlPolicies?: CacheTtlPolicy[];
}

// ── Namespace handle ──────────────────────────────────────

/**
 * A namespaced view over the CacheManager. All keys are automatically
 * prefixed with `{namespace}:` so different subsystems don't collide.
 */
export interface NamespacedCache {
  get<T = unknown>(key: string): T | undefined;
  /** Retrieve value with staleness metadata for stale-while-revalidate pattern */
  getWithStaleness<T = unknown>(key: string): { value: T; isStale: boolean } | undefined;
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void;
  delete(key: string): boolean;
  invalidateByTag(tag: string): number;
  /** Invalidate all keys in this namespace */
  invalidateAll(): number;
}

// ── Event types that trigger invalidation ─────────────────

/** Runtime events emitted by Action Engine after successful writes */
const WRITE_EVENT_TYPES = new Set(["record.created", "record.updated", "record.deleted"]);

/** Permission-related action names whose success should flush permission caches */
const PERMISSION_ACTION_PREFIXES = [
  "assign_role",
  "revoke_role",
  "update_role",
  "update_permission",
];

// ── CacheManager ──────────────────────────────────────────

export class CacheManager {
  private l1: CacheProvider;
  private l2: CacheProvider | undefined;
  private logger: Logger | undefined;
  private defaultTtl: number | undefined;
  private ttlPolicies: CacheTtlPolicy[];

  constructor(options?: CacheManagerOptions) {
    this.l1 = options?.l1 ?? new InMemoryCacheProvider();
    this.l2 = options?.l2;
    this.logger = options?.logger;
    this.defaultTtl = options?.defaultTtl;
    this.ttlPolicies = options?.ttlPolicies ?? [];

    // Wire up event-driven invalidation
    if (options?.eventBus) {
      this.subscribeToEvents(options.eventBus);
    }
  }

  // ── Core operations ─────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    return this.getWithStaleness<T>(key)?.value;
  }

  /**
   * Retrieve a value with staleness metadata for stale-while-revalidate pattern.
   * Returns `{ value, isStale: true }` when in SWR window.
   */
  getWithStaleness<T = unknown>(key: string): { value: T; isStale: boolean } | undefined {
    // Try L1 first
    const l1Result = this.l1.getWithStaleness<T>(key);
    if (l1Result !== undefined) return l1Result;

    // Try L2 if available
    if (this.l2) {
      const l2Result = this.l2.getWithStaleness<T>(key);
      if (l2Result !== undefined) {
        // Promote to L1 (without SWR metadata since original options are not available)
        this.l1.set(key, l2Result.value);
        return l2Result;
      }
    }

    return undefined;
  }

  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void {
    const opts: CacheSetOptions = {
      ...options,
      ttl: options?.ttl ?? this.defaultTtl,
    };
    this.l1.set(key, value, opts);
    if (this.l2) {
      this.l2.set(key, value, opts);
    }
  }

  delete(key: string): boolean {
    const l1Deleted = this.l1.delete(key);
    const l2Deleted = this.l2?.delete(key) ?? false;
    return l1Deleted || l2Deleted;
  }

  invalidateByTag(tag: string): number {
    const l1Count = this.l1.invalidateByTag(tag);
    const l2Count = this.l2?.invalidateByTag(tag) ?? 0;
    return l1Count + l2Count;
  }

  invalidateByPrefix(prefix: string): number {
    const l1Count = this.l1.invalidateByPrefix(prefix);
    const l2Count = this.l2?.invalidateByPrefix(prefix) ?? 0;
    return l1Count + l2Count;
  }

  clear(): void {
    this.l1.clear();
    this.l2?.clear();
  }

  stats(): { l1: CacheStats; l2?: CacheStats } {
    return {
      l1: this.l1.stats(),
      l2: this.l2?.stats(),
    };
  }

  /**
   * Return comprehensive diagnostics including per-namespace breakdown
   * and memory estimates. See spec §9.
   */
  getStats(options?: CacheManagerStatsOptions): CacheManagerStats {
    const l1 = this.l1.stats();
    const l2 = this.l2?.stats();

    const totalHits = l1.hits + (l2?.hits ?? 0);
    const totalMisses = l2?.misses ?? l1.misses;
    const totalRequests = totalHits + totalMisses;

    const rawAvg = options?.avgEntrySizeBytes ?? 256;
    const avgEntryBytes = Number.isFinite(rawAvg) && rawAvg > 0 ? rawAvg : 256;

    const namespaces = this.collectNamespaceBreakdown();
    const totalEntries = l1.size + (l2?.size ?? 0);

    // Account for L2 entries not visible in L1 namespace scan
    const namespacedEntries = Object.values(namespaces).reduce((sum, count) => sum + count, 0);
    if (namespacedEntries < totalEntries) {
      namespaces._unattributed = totalEntries - namespacedEntries;
    }

    return {
      totalEntries,
      hits: totalHits,
      misses: totalMisses,
      hitRate: totalRequests === 0 ? 0 : totalHits / totalRequests,
      evictions: l1.evictions + (l2?.evictions ?? 0),
      estimatedMemoryBytes: totalEntries * avgEntryBytes,
      namespaces,
      l1,
      l2,
    };
  }

  // ── Namespace factory ───────────────────────────────────

  namespace(ns: string): NamespacedCache {
    const prefix = `${ns}:`;
    const manager = this;
    const resolvedPolicy = resolveTtlForNamespace(ns, this.ttlPolicies);

    return {
      get<T = unknown>(key: string): T | undefined {
        return manager.get<T>(`${prefix}${key}`);
      },
      getWithStaleness<T = unknown>(key: string): { value: T; isStale: boolean } | undefined {
        return manager.getWithStaleness<T>(`${prefix}${key}`);
      },
      set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void {
        // Auto-apply TTL policy when no explicit TTL is provided
        if (resolvedPolicy && options?.ttl === undefined) {
          const merged: CacheSetOptions = {
            ...options,
            ttl: resolvedPolicy.ttl,
            swrTtl: options?.swrTtl ?? resolvedPolicy.swrTtl,
          };
          manager.set(`${prefix}${key}`, value, merged);
        } else {
          manager.set(`${prefix}${key}`, value, options);
        }
      },
      delete(key: string): boolean {
        return manager.delete(`${prefix}${key}`);
      },
      invalidateByTag(tag: string): number {
        return manager.invalidateByTag(tag);
      },
      invalidateAll(): number {
        return manager.invalidateByPrefix(prefix);
      },
    };
  }

  /**
   * Create a tenant-scoped namespaced cache.
   * Keys are prefixed with `{ns}:{tenantId}:` for tenant isolation.
   * Convenience wrapper around `namespace()`.
   */
  tenantNamespace(ns: string, tenantId: string): NamespacedCache {
    if (ns.includes(":")) {
      throw new Error(`Cache namespace must not contain ':' delimiter, got "${ns}"`);
    }
    if (tenantId.includes(":")) {
      throw new Error(`Tenant ID must not contain ':' delimiter, got "${tenantId}"`);
    }
    return this.namespace(`${ns}:${tenantId}`);
  }

  // ── Event-driven invalidation ───────────────────────────

  /**
   * Handle an event for cache invalidation. Public so it can be
   * called directly in tests or by custom integrations.
   */
  handleEvent(event: EventRecord): void {
    if (!WRITE_EVENT_TYPES.has(event.type)) return;

    const { entity, tenantId, action } = event;

    // Invalidate query caches for the affected entity
    if (entity) {
      const tag = tenantId ? `entity:${tenantId}:${entity}` : `entity:${entity}`;
      const count = this.invalidateByTag(tag);
      this.logger?.debug?.(`Cache invalidated ${count} entries for tag "${tag}" on ${event.type}`);
    }

    // Invalidate permission caches if the action is permission-related
    if (action && PERMISSION_ACTION_PREFIXES.some((p) => action.startsWith(p))) {
      const permTag = tenantId ? `perm:${tenantId}` : "perm";
      const count = this.invalidateByTag(permTag);
      this.logger?.debug?.(`Cache invalidated ${count} permission entries for tag "${permTag}"`);
    }
  }

  /**
   * Scan L1 keys to build per-namespace entry counts.
   * Only works when L1 exposes a keys() method (e.g. InMemoryCacheProvider).
   */
  private collectNamespaceBreakdown(): Record<string, number> {
    const result: Record<string, number> = {};
    const provider = this.l1 as { keys?: () => string[] };
    if (typeof provider.keys !== "function") return result;

    for (const key of provider.keys()) {
      const colonIdx = key.indexOf(":");
      const ns = colonIdx === -1 ? "_default" : key.slice(0, colonIdx);
      result[ns] = (result[ns] ?? 0) + 1;
    }
    return result;
  }

  private subscribeToEvents(eventBus: EventBus): void {
    // Subscribe as sync handlers so cache invalidation runs inline
    // before subsequent reads see stale cached data.
    for (const eventType of WRITE_EVENT_TYPES) {
      eventBus.subscribe(
        eventType,
        (event: EventRecord) => {
          this.handleEvent(event);
        },
        { sync: true },
      );
    }
  }
}
