/**
 * PostgresCacheInvalidator — Postgres LISTEN/NOTIFY based multi-instance cache invalidation
 *
 * Phase 1 multi-instance strategy (spec §7):
 * - After each write Action, call notify() to publish an invalidation payload
 * - All instances LISTEN on the same channel and invalidate their local L1 cache
 * - TTL provides eventual consistency guarantee if NOTIFY is missed
 *
 * Suitable for deployments with < 10 instances. For larger deployments, use Redis Pub/Sub (Phase 2).
 *
 * Channel: "linchkit_cache_invalidation"
 * Payload JSON: { tenantId?: string, type: "entity" | "permission" | "definition", target: string }
 */

import postgres from "postgres";
import type { CacheManager } from "./cache-manager";

export const CACHE_INVALIDATION_CHANNEL = "linchkit_cache_invalidation";

export interface CacheInvalidationPayload {
  /** Tenant ID to scope invalidation (undefined = all tenants) */
  tenantId?: string;
  /** Type of cache to invalidate */
  type: "entity" | "permission" | "definition";
  /** Target identifier (schema name, definition key, etc.) */
  target: string;
}

export interface PostgresCacheInvalidatorOptions {
  /** Postgres connection URL */
  connectionUrl: string;
  /** CacheManager whose L1 will be invalidated on NOTIFY */
  cacheManager: CacheManager;
  /**
   * Optional logger for debug/error output.
   * Defaults to no-op if not provided.
   */
  logger?: {
    debug?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
  };
}

/**
 * Multi-instance cache invalidator using Postgres LISTEN/NOTIFY.
 *
 * Usage:
 * ```ts
 * const invalidator = new PostgresCacheInvalidator({ connectionUrl, cacheManager });
 * await invalidator.start();
 * // ...after a write action:
 * await invalidator.notify({ type: "entity", target: "orders", tenantId: "t1" });
 * // ...on shutdown:
 * await invalidator.stop();
 * ```
 */
export class PostgresCacheInvalidator {
  private connectionUrl: string;
  private cacheManager: CacheManager;
  private logger: NonNullable<PostgresCacheInvalidatorOptions["logger"]>;
  private sql: ReturnType<typeof postgres> | null = null;
  private started = false;

  constructor(options: PostgresCacheInvalidatorOptions) {
    this.connectionUrl = options.connectionUrl;
    this.cacheManager = options.cacheManager;
    this.logger = options.logger ?? {};
  }

  /**
   * Start listening for invalidation notifications from other instances.
   * Opens a dedicated Postgres connection for LISTEN (cannot share with query connection).
   */
  async start(): Promise<void> {
    if (this.started) return;

    try {
      // Dedicated connection for LISTEN — must not be pooled
      this.sql = postgres(this.connectionUrl, {
        max: 1,
        idle_timeout: 0, // keep alive indefinitely
        connection: { application_name: "linchkit-cache-invalidator" },
      });

      await this.sql.listen(
        CACHE_INVALIDATION_CHANNEL,
        (payload: string) => {
          this.handleNotification(payload);
        },
        () => {
          this.logger.debug?.("[PostgresCacheInvalidator] LISTEN connection established");
        },
      );

      this.started = true;
    } catch (err) {
      this.logger.error?.("[PostgresCacheInvalidator] Failed to start LISTEN", err);
      throw err;
    }
  }

  /**
   * Send a NOTIFY to all listening instances (including self).
   * Call this after a successful write Action.
   *
   * Uses a separate query connection, not the LISTEN connection.
   */
  async notify(payload: CacheInvalidationPayload): Promise<void> {
    if (!this.sql) {
      throw new Error("PostgresCacheInvalidator is not started. Call start() first.");
    }

    const payloadStr = JSON.stringify(payload);
    try {
      await this.sql.notify(CACHE_INVALIDATION_CHANNEL, payloadStr);
      this.logger.debug?.(`[PostgresCacheInvalidator] NOTIFY sent: ${payloadStr}`);
    } catch (err) {
      this.logger.error?.(`[PostgresCacheInvalidator] NOTIFY failed: ${payloadStr}`, err);
      // Non-fatal: TTL will ensure eventual consistency
    }
  }

  /**
   * Stop listening and close the connection.
   */
  async stop(): Promise<void> {
    if (this.sql) {
      try {
        await this.sql.end({ timeout: 3 });
      } catch {
        // Ignore close errors
      }
      this.sql = null;
    }
    this.started = false;
  }

  // ── Internal ─────────────────────────────────────────────

  private handleNotification(payloadStr: string): void {
    let payload: CacheInvalidationPayload;
    try {
      payload = JSON.parse(payloadStr) as CacheInvalidationPayload;
    } catch {
      this.logger.error?.(
        `[PostgresCacheInvalidator] Invalid JSON in NOTIFY payload: ${payloadStr}`,
      );
      return;
    }

    const { type, target, tenantId } = payload;

    switch (type) {
      case "entity": {
        // Invalidate all query caches for this schema (scoped to tenant if provided)
        const tag = tenantId ? `entity:${tenantId}:${target}` : `entity:${target}`;
        const count = this.cacheManager.invalidateByTag(tag);
        this.logger.debug?.(
          `[PostgresCacheInvalidator] Invalidated ${count} entries for tag "${tag}"`,
        );
        break;
      }
      case "permission": {
        // Invalidate permission caches for the tenant
        const permTag = tenantId ? `perm:${tenantId}` : "perm";
        const count = this.cacheManager.invalidateByTag(permTag);
        this.logger.debug?.(
          `[PostgresCacheInvalidator] Invalidated ${count} permission entries for tag "${permTag}"`,
        );
        break;
      }
      case "definition": {
        // Invalidate tenant override definition caches
        const defPrefix = tenantId ? `override:${tenantId}:${target}` : `override:${target}`;
        const count = this.cacheManager.invalidateByPrefix(defPrefix);
        this.logger.debug?.(
          `[PostgresCacheInvalidator] Invalidated ${count} definition entries with prefix "${defPrefix}"`,
        );
        break;
      }
      default: {
        this.logger.error?.(`[PostgresCacheInvalidator] Unknown invalidation type: ${type}`);
      }
    }
  }
}
