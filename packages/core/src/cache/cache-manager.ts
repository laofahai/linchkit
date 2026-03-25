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
}

// ── Namespace handle ──────────────────────────────────────

/**
 * A namespaced view over the CacheManager. All keys are automatically
 * prefixed with `{namespace}:` so different subsystems don't collide.
 */
export interface NamespacedCache {
  get<T = unknown>(key: string): T | undefined;
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

  constructor(options?: CacheManagerOptions) {
    this.l1 = options?.l1 ?? new InMemoryCacheProvider();
    this.l2 = options?.l2;
    this.logger = options?.logger;
    this.defaultTtl = options?.defaultTtl;

    // Wire up event-driven invalidation
    if (options?.eventBus) {
      this.subscribeToEvents(options.eventBus);
    }
  }

  // ── Core operations ─────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    // Try L1 first
    const l1Result = this.l1.get<T>(key);
    if (l1Result !== undefined) return l1Result;

    // Try L2 if available
    if (this.l2) {
      const l2Result = this.l2.get<T>(key);
      if (l2Result !== undefined) {
        // Promote to L1
        this.l1.set(key, l2Result);
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

  // ── Namespace factory ───────────────────────────────────

  namespace(ns: string): NamespacedCache {
    const prefix = `${ns}:`;
    const manager = this;

    return {
      get<T = unknown>(key: string): T | undefined {
        return manager.get<T>(`${prefix}${key}`);
      },
      set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void {
        manager.set(`${prefix}${key}`, value, options);
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

  // ── Event-driven invalidation ───────────────────────────

  /**
   * Handle an event for cache invalidation. Public so it can be
   * called directly in tests or by custom integrations.
   */
  handleEvent(event: EventRecord): void {
    if (!WRITE_EVENT_TYPES.has(event.type)) return;

    const { schema, tenantId, action } = event;

    // Invalidate query caches for the affected schema
    if (schema) {
      const tag = tenantId ? `schema:${tenantId}:${schema}` : `schema:${schema}`;
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
