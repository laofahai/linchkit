/**
 * EventReplayService — Re-dispatch past events and inspect handler delivery
 *
 * Operates on the existing `_linchkit.events` table — does NOT introduce a new
 * system table. Provides:
 *   - `list` / `get` for browsing persisted events
 *   - `replay` / `replayBatch` for re-dispatching events through registered
 *     handlers WITHOUT mutating the original row (no new outbox entry, no
 *     status change on the source event)
 *   - `handlerHistory` for the per-event delivery summary
 *
 * Replay re-runs handlers in the registry for the event type, collecting
 * per-handler results so the caller can surface failures rather than have
 * them silently swallowed (cf. Spec 66 §4 "replay must not silently ignore
 * handler failures"). The original event row is never modified.
 */

import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { withTraceId } from "../observability/trace-context";
import { eventsTable } from "../persistence/system-tables";
import type { EventHandlerContext, EventHandlerDefinition, EventRecord } from "../types/event";
import { ExecutionMetaImpl } from "../types/execution-meta";
import { type EventHandlerRegistry, matchesFilter } from "./event-bus";

// ── Public types ────────────────────────────────────────────

export interface EventSummary {
  id: string;
  tenantId?: string;
  eventType: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  sourceAction?: string;
  sourceExecutionId?: string;
  retryCount: number;
  errorMessage?: string;
  createdAt: Date;
  processedAt?: Date;
}

export interface EventDetail extends EventSummary {
  payload: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  /** Per-event delivery history (current schema records the latest aggregate result). */
  history: HandlerExecution[];
}

/**
 * Handler execution summary derived from the events row.
 *
 * The current schema stores a single aggregate status per event row, not per
 * (event, handler) pair. Each event therefore produces exactly one
 * `HandlerExecution` whose `handler` is the wildcard sentinel `"*"`. Once
 * outbox_completions (Spec 66 §2.4) lands this becomes per-handler.
 */
export interface HandlerExecution {
  eventId: string;
  /** `"*"` until per-handler completion tracking exists (Spec 66 §2.4). */
  handler: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  retryCount: number;
  errorMessage?: string;
  attemptedAt: Date;
  completedAt?: Date;
}

export interface ReplayError {
  handler: string;
  message: string;
}

export interface ReplayResult {
  /** Number of (handler, event) pairs successfully invoked */
  delivered: number;
  errors: ReplayError[];
}

export interface BatchReplayResult {
  /** Per-event replay outcome, keyed by event id (in input order) */
  results: Array<{ id: string; replayed: boolean; delivered: number; errors: ReplayError[] }>;
  /** Total handler invocations succeeded across all events */
  totalDelivered: number;
  /** Total handler errors collected across all events */
  totalErrors: number;
}

export interface EventListOptions {
  tenantId?: string;
  /** Filter by sourceAction (the action that emitted the event). */
  entity?: string;
  eventType?: string;
  /** Lower-bound (inclusive) on `createdAt`. */
  since?: Date;
  /** Upper-bound (inclusive) on `createdAt`. */
  until?: Date;
  /** Max entries to return (default: 50, max: 100) */
  limit?: number;
  /** Number of entries to skip (default: 0) */
  offset?: number;
}

export interface ReplayOptions {
  /** When set, only the named handler is invoked (bypassing other listeners). */
  onlyHandler?: string;
}

export interface HandlerHistoryQuery {
  eventId: string;
  /** When set, restrict history to the named handler. */
  handler?: string;
}

export interface EventReplayService {
  /** Paginated list of persisted events with optional filtering. */
  list(options?: EventListOptions): Promise<{ items: EventSummary[]; total: number }>;
  /** Full event detail (payload + delivery history) by id; null if missing. */
  get(id: string): Promise<EventDetail | null>;
  /** Re-dispatch a single event to its registered handlers. */
  replay(id: string, opts?: ReplayOptions): Promise<ReplayResult>;
  /** Bulk replay; processes ids sequentially. */
  replayBatch(ids: string[], opts?: ReplayOptions): Promise<BatchReplayResult>;
  /** Per-event handler delivery history; empty when event missing. */
  handlerHistory(query: HandlerHistoryQuery): Promise<HandlerExecution[]>;
}

export interface EventReplayServiceOptions {
  db: PostgresJsDatabase;
  registry: EventHandlerRegistry;
}

// ── Internal helpers ────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PRIORITY = 100;
const MAX_BATCH_SIZE = 100;

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.trunc(n), max)) : fallback;
}

function clampOffset(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function rowToSummary(row: typeof eventsTable.$inferSelect): EventSummary {
  return {
    id: row.id,
    tenantId: row.tenantId ?? undefined,
    eventType: row.eventType,
    status: row.status,
    sourceAction: row.sourceAction ?? undefined,
    sourceExecutionId: row.sourceExecutionId ?? undefined,
    retryCount: row.retryCount,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? undefined,
  };
}

function rowToDetail(row: typeof eventsTable.$inferSelect): EventDetail {
  return {
    ...rowToSummary(row),
    payload: (row.payload as Record<string, unknown>) ?? {},
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    history: [rowToHistory(row)],
  };
}

function rowToHistory(row: typeof eventsTable.$inferSelect): HandlerExecution {
  return {
    eventId: row.id,
    handler: "*",
    status: row.status,
    retryCount: row.retryCount,
    errorMessage: row.errorMessage ?? undefined,
    attemptedAt: row.processedAt ?? row.createdAt,
    completedAt: row.processedAt ?? undefined,
  };
}

/**
 * Reconstruct an EventRecord from a persisted row. Mirrors OutboxWorker's
 * rowToEventRecord — keep the two shapes in sync if either changes.
 */
function rowToEventRecord(row: typeof eventsTable.$inferSelect): EventRecord {
  const payload = (row.payload as Record<string, unknown>) ?? {};
  const metaJson = (row.meta as Record<string, unknown> | null | undefined) ?? undefined;
  let meta: ExecutionMetaImpl | undefined;
  if (metaJson) {
    try {
      meta = new ExecutionMetaImpl(metaJson);
    } catch {
      // Persisted meta failed validation — fall back to empty so replay still
      // proceeds. OutboxWorker logs this case; the replay path leaves
      // observability to the caller (which sees `errors` per-handler if
      // anything downstream throws).
      meta = undefined;
    }
  }
  return {
    id: row.id,
    type: row.eventType,
    category: "runtime",
    timestamp: row.createdAt,
    actor: { type: "system", id: "event-replay" },
    executionId: row.sourceExecutionId ?? "",
    tenantId: row.tenantId ?? undefined,
    payload,
    meta,
  };
}

/** Handler context for replay — emits are swallowed to avoid cascading replays. */
function createReplayContext(meta: ExecutionMetaImpl | undefined): EventHandlerContext {
  return {
    emit: () => {
      // Replay does not propagate chained emits; downstream events are out of
      // scope for a single-event re-dispatch (Spec 66 §4.3 safety guards).
    },
    meta: meta ?? new ExecutionMetaImpl({}),
  };
}

function selectHandlers(
  registry: EventHandlerRegistry,
  eventType: string,
  payload: Record<string, unknown>,
  onlyHandler: string | undefined,
): EventHandlerDefinition[] {
  const all = registry.getByEvent(eventType);
  const filtered = all.filter((h) => {
    if (onlyHandler && h.name !== onlyHandler) return false;
    if (!h.filter) return true;
    return matchesFilter(payload, h.filter);
  });
  filtered.sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));
  return filtered;
}

// ── Factory ─────────────────────────────────────────────────

export function createEventReplayService(opts: EventReplayServiceOptions): EventReplayService {
  const { db, registry } = opts;

  function buildWhere(options?: EventListOptions): SQL | undefined {
    const filters: SQL[] = [];
    if (options?.tenantId !== undefined) filters.push(eq(eventsTable.tenantId, options.tenantId));
    if (options?.eventType !== undefined)
      filters.push(eq(eventsTable.eventType, options.eventType));
    if (options?.entity !== undefined) filters.push(eq(eventsTable.sourceAction, options.entity));
    if (options?.since instanceof Date) filters.push(gte(eventsTable.createdAt, options.since));
    if (options?.until instanceof Date) filters.push(lte(eventsTable.createdAt, options.until));
    if (filters.length === 0) return undefined;
    if (filters.length === 1) return filters[0];
    return and(...filters);
  }

  async function list(
    options?: EventListOptions,
  ): Promise<{ items: EventSummary[]; total: number }> {
    const limit = clampLimit(options?.limit, 50, 100);
    const offset = clampOffset(options?.offset);
    const where = buildWhere(options);

    const [rows, totals] = await Promise.all([
      where
        ? db
            .select()
            .from(eventsTable)
            .where(where)
            .orderBy(desc(eventsTable.createdAt))
            .limit(limit)
            .offset(offset)
        : db
            .select()
            .from(eventsTable)
            .orderBy(desc(eventsTable.createdAt))
            .limit(limit)
            .offset(offset),
      where
        ? db.select({ total: count() }).from(eventsTable).where(where)
        : db.select({ total: count() }).from(eventsTable),
    ]);

    return {
      items: rows.map(rowToSummary),
      total: Number(totals[0]?.total ?? 0),
    };
  }

  async function get(id: string): Promise<EventDetail | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
    return rows[0] ? rowToDetail(rows[0]) : null;
  }

  async function fetchRow(id: string): Promise<typeof eventsTable.$inferSelect | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function replay(id: string, options?: ReplayOptions): Promise<ReplayResult> {
    const row = await fetchRow(id);
    if (!row) return { delivered: 0, errors: [] };
    return dispatchRow(row, options?.onlyHandler);
  }

  async function dispatchRow(
    row: typeof eventsTable.$inferSelect,
    onlyHandler: string | undefined,
  ): Promise<ReplayResult> {
    const event = rowToEventRecord(row);
    const handlers = selectHandlers(registry, event.type, event.payload, onlyHandler);
    if (handlers.length === 0) return { delivered: 0, errors: [] };

    const ctx = createReplayContext(event.meta as ExecutionMetaImpl | undefined);
    const traceId = (event.payload as Record<string, unknown>)?._traceId as string | undefined;

    let delivered = 0;
    const errors: ReplayError[] = [];

    for (const handler of handlers) {
      // Shallow copy so handler mutations cannot leak to siblings/replays.
      const eventCopy: EventRecord = { ...event, payload: { ...event.payload } };
      try {
        const exec = () => handler.handler(eventCopy, ctx);
        if (traceId) {
          await withTraceId(traceId, exec);
        } else {
          await exec();
        }
        delivered++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ handler: handler.name, message });
      }
    }

    return { delivered, errors };
  }

  async function replayBatch(ids: string[], options?: ReplayOptions): Promise<BatchReplayResult> {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { results: [], totalDelivered: 0, totalErrors: 0 };
    }
    if (ids.length > MAX_BATCH_SIZE) {
      throw new Error(`replayBatch: batch size ${ids.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    const results: BatchReplayResult["results"] = [];
    let totalDelivered = 0;
    let totalErrors = 0;

    for (const id of ids) {
      if (!UUID_RE.test(id)) {
        results.push({ id, replayed: false, delivered: 0, errors: [] });
        continue;
      }
      const row = await fetchRow(id);
      if (!row) {
        results.push({ id, replayed: false, delivered: 0, errors: [] });
        continue;
      }
      const outcome = await dispatchRow(row, options?.onlyHandler);
      results.push({
        id,
        replayed: true,
        delivered: outcome.delivered,
        errors: outcome.errors,
      });
      totalDelivered += outcome.delivered;
      totalErrors += outcome.errors.length;
    }

    return { results, totalDelivered, totalErrors };
  }

  async function handlerHistory(query: HandlerHistoryQuery): Promise<HandlerExecution[]> {
    if (!UUID_RE.test(query.eventId)) return [];
    const rows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.id, query.eventId))
      .limit(1);
    if (rows.length === 0) return [];

    const history = rows.map(rowToHistory);
    if (query.handler === undefined) return history;
    // Wildcard sentinel `"*"` represents "all handlers"; until per-handler
    // tracking exists, only the wildcard matches an explicit name filter.
    return history.filter((h) => h.handler === query.handler || h.handler === "*");
  }

  return { list, get, replay, replayBatch, handlerHistory };
}
