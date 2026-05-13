/**
 * DlqService — Dead Letter Queue inspection and replay
 *
 * Provides read and management access to events that have exhausted all
 * retry attempts and been moved to `dead_letter` status by OutboxWorker.
 * Callers can list, inspect, replay (reset to pending), or purge entries.
 */

import { and, count, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eventsTable } from "../persistence/system-tables";

// ── Public types ────────────────────────────────────────────

export interface DlqEntry {
  id: string;
  tenantId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  errorMessage?: string;
  retryCount: number;
  createdAt: Date;
  processedAt?: Date;
}

export interface DlqListOptions {
  tenantId?: string;
  eventType?: string;
  /** Max entries to return (default: 50) */
  limit?: number;
  /** Number of entries to skip (default: 0) */
  offset?: number;
}

export interface DlqStats {
  /** Total dead-letter count across all event types */
  total: number;
  /** Per-eventType breakdown */
  byEventType: Record<string, number>;
}

export interface DlqService {
  /**
   * List dead-letter events with optional tenant/eventType filter and pagination.
   * Returns entries in descending creation order.
   */
  list(options?: DlqListOptions): Promise<{ entries: DlqEntry[]; total: number }>;

  /**
   * Get a single dead-letter event by id.
   * Returns null if the event does not exist or is not in dead_letter status.
   */
  get(id: string): Promise<DlqEntry | null>;

  /**
   * Reset a dead-letter event to pending so OutboxWorker picks it up again.
   * Clears retryCount, nextRetryAt, and errorMessage.
   * Returns true if the event was found and reset, false if not found.
   */
  replay(id: string): Promise<boolean>;

  /**
   * Permanently delete a dead-letter event.
   * Returns true if the event was found and deleted, false if not found.
   */
  purge(id: string): Promise<boolean>;

  /**
   * Count dead-letter events grouped by eventType.
   * Useful for alerting when the queue grows unexpectedly.
   */
  getStats(tenantId?: string): Promise<DlqStats>;
}

// ── Internal helpers ────────────────────────────────────────

function rowToEntry(row: typeof eventsTable.$inferSelect): DlqEntry {
  return {
    id: row.id,
    tenantId: row.tenantId ?? undefined,
    eventType: row.eventType,
    payload: (row.payload as Record<string, unknown>) ?? {},
    errorMessage: row.errorMessage ?? undefined,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? undefined,
  };
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create a DlqService backed by the given Drizzle database connection.
 */
export function createDlqService(db: PostgresJsDatabase): DlqService {
  async function list(options?: DlqListOptions): Promise<{ entries: DlqEntry[]; total: number }> {
    const { tenantId, eventType, limit = 50, offset = 0 } = options ?? {};

    const where = and(
      eq(eventsTable.status, "dead_letter"),
      ...(tenantId !== undefined ? [eq(eventsTable.tenantId, tenantId)] : []),
      ...(eventType !== undefined ? [eq(eventsTable.eventType, eventType)] : []),
    );

    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(eventsTable)
        .where(where)
        .orderBy(desc(eventsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(eventsTable).where(where),
    ]);

    return {
      entries: rows.map(rowToEntry),
      total: Number(totals[0]?.total ?? 0),
    };
  }

  async function get(id: string): Promise<DlqEntry | null> {
    const rows = await db
      .select()
      .from(eventsTable)
      .where(and(eq(eventsTable.id, id), eq(eventsTable.status, "dead_letter")))
      .limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async function replay(id: string): Promise<boolean> {
    const result = await db
      .update(eventsTable)
      .set({
        status: "pending",
        retryCount: 0,
        nextRetryAt: null,
        errorMessage: null,
      })
      .where(and(eq(eventsTable.id, id), eq(eventsTable.status, "dead_letter")))
      .returning({ id: eventsTable.id });
    return result.length > 0;
  }

  async function purge(id: string): Promise<boolean> {
    const result = await db
      .delete(eventsTable)
      .where(and(eq(eventsTable.id, id), eq(eventsTable.status, "dead_letter")))
      .returning({ id: eventsTable.id });
    return result.length > 0;
  }

  async function getStats(tenantId?: string): Promise<DlqStats> {
    const where = and(
      eq(eventsTable.status, "dead_letter"),
      ...(tenantId !== undefined ? [eq(eventsTable.tenantId, tenantId)] : []),
    );

    const rows = await db
      .select({ eventType: eventsTable.eventType, n: count() })
      .from(eventsTable)
      .where(where)
      .groupBy(eventsTable.eventType);

    const byEventType: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      const n = Number(row.n);
      byEventType[row.eventType] = n;
      total += n;
    }

    return { total, byEventType };
  }

  return { list, get, replay, purge, getStats };
}
