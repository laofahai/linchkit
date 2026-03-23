/**
 * OutboxWorker — Reliable event processing with retry
 *
 * Polls the `_linchkit_events` table for failed events and retries
 * handler execution with exponential backoff. Also picks up
 * "stuck" pending events that were never processed (e.g., crash recovery).
 *
 * Lifecycle: create → start() → stop()
 */

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EventHandlerContext, EventHandlerDefinition, EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import { consoleLogger } from "./console-logger";
import { type EventHandlerRegistry, matchesFilter } from "./event-bus";
import { eventsTable } from "./system-tables";

const DEFAULT_PRIORITY = 100;

export interface OutboxWorkerOptions {
  /** Drizzle database instance */
  db: PostgresJsDatabase;
  /** Event handler registry for re-executing handlers */
  registry: EventHandlerRegistry;
  /** Poll interval in milliseconds (default: 5000) */
  pollIntervalMs?: number;
  /** Maximum retry attempts before giving up (default: 5) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 300000 = 5 min) */
  maxDelayMs?: number;
  /** Batch size per poll (default: 10) */
  batchSize?: number;
  /** Logger instance */
  logger?: Logger;
}

export interface OutboxWorker {
  /** Start polling for retryable events */
  start(): void;
  /** Stop polling (completes current batch) */
  stop(): Promise<void>;
  /** Process one batch manually (useful for testing) */
  processBatch(): Promise<number>;
}

/**
 * Create an OutboxWorker that retries failed events with exponential backoff.
 */
export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const {
    db,
    registry,
    pollIntervalMs = 5000,
    maxRetries = 5,
    baseDelayMs = 1000,
    maxDelayMs = 300_000,
    batchSize = 10,
    logger = consoleLogger,
  } = options;

  let timer: ReturnType<typeof setInterval> | null = null;
  let processing = false;
  let stopped = false;

  /** Calculate exponential backoff delay with jitter */
  function calculateDelay(retryCount: number): number {
    const delay = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
    // Add ±25% jitter to prevent thundering herd
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  /**
   * Raw row shape returned by db.execute() — column names are snake_case
   * as they come directly from PostgreSQL.
   */
  interface RawEventRow {
    id: string;
    tenant_id: string | null;
    event_type: string;
    payload: unknown;
    source_action: string | null;
    source_execution_id: string | null;
    created_at: Date | string;
    processed_at: Date | string | null;
    status: string;
    error_message: string | null;
    retry_count: number;
    next_retry_at: Date | string | null;
  }

  /** Build an EventRecord from a raw database row (snake_case columns) */
  function rowToEventRecord(row: RawEventRow): EventRecord {
    const payload = (row.payload as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      type: row.event_type,
      category: "runtime",
      timestamp: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      actor: { type: "system", id: "outbox-worker" },
      executionId: row.source_execution_id ?? "",
      tenantId: row.tenant_id ?? undefined,
      payload,
    };
  }

  /** Create a minimal handler context for re-execution */
  function createHandlerContext(): EventHandlerContext {
    return {
      execute: () => {
        throw new Error("execute() is not wired in OutboxWorker");
      },
      emit: () => {
        // Swallow re-emissions from retry context to prevent cascading retries
      },
      get: () => {
        throw new Error("get() is not wired in OutboxWorker");
      },
      query: () => {
        throw new Error("query() is not wired in OutboxWorker");
      },
    };
  }

  /** Execute matching handlers for an event record */
  async function executeHandlers(event: EventRecord): Promise<void> {
    const handlers = registry.getByEvent(event.type);
    const matched = handlers.filter((h: EventHandlerDefinition) => {
      if (!h.filter) return true;
      return matchesFilter(event.payload, h.filter);
    });

    matched.sort(
      (a: EventHandlerDefinition, b: EventHandlerDefinition) =>
        (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
    );

    const ctx = createHandlerContext();

    for (const handler of matched) {
      const eventCopy = { ...event, payload: { ...event.payload } };
      await handler.handler(eventCopy, ctx);
    }
  }

  /** Process a single batch of retryable events */
  async function processBatch(): Promise<number> {
    const now = new Date();

    // Find events eligible for processing:
    // 1. status = 'pending' — new events from Transactional Outbox
    // 2. status = 'failed' AND retryCount < maxRetries AND nextRetryAt ready — retries
    // 3. status = 'processing' AND stuck for > 5 minutes — crash recovery
    //
    // Uses atomic UPDATE with FOR UPDATE SKIP LOCKED subquery to prevent
    // multiple worker instances from claiming the same events.
    const stuckThreshold = new Date(now.getTime() - 5 * 60 * 1000);

    // Atomic claim: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
    // The inner CTE selects and locks eligible rows, then the outer UPDATE claims them.
    // This prevents multiple worker instances from processing the same events.
    const nowStr = now.toISOString();
    const stuckStr = stuckThreshold.toISOString();
    const rawRows = await db.execute(sql`
      WITH claimable AS (
        SELECT id FROM _linchkit_events
        WHERE (
          status = 'pending'
          OR (status = 'failed' AND retry_count <= ${maxRetries - 1} AND (next_retry_at IS NULL OR next_retry_at <= ${nowStr}::timestamptz))
          OR (status = 'processing' AND created_at <= ${stuckStr}::timestamptz)
        )
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE _linchkit_events
      SET status = 'processing'
      FROM claimable
      WHERE _linchkit_events.id = claimable.id
      RETURNING _linchkit_events.*
    `);

    // db.execute() returns a RowList (array-like) of Record<string, unknown>
    const rows = Array.from(rawRows) as unknown as RawEventRow[];

    if (rows.length === 0) return 0;

    let processed = 0;

    for (const row of rows) {
      if (stopped) break;

      const event = rowToEventRecord(row);

      try {
        // Re-execute handlers
        await executeHandlers(event);

        // Mark as completed
        await db
          .update(eventsTable)
          .set({
            status: "completed",
            processedAt: new Date(),
            errorMessage: null,
          })
          .where(eq(eventsTable.id, row.id));

        processed++;
        logger.info(
          `[OutboxWorker] Event "${row.id}" (${row.event_type}) succeeded on retry ${row.retry_count + 1}`,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const newRetryCount = row.retry_count + 1;

        if (newRetryCount >= maxRetries) {
          // Exhausted retries — leave as failed with no nextRetryAt
          await db
            .update(eventsTable)
            .set({
              status: "failed",
              errorMessage,
              retryCount: newRetryCount,
              nextRetryAt: null,
            })
            .where(eq(eventsTable.id, row.id));

          logger.warn(
            `[OutboxWorker] Event "${row.id}" (${row.event_type}) exhausted ${maxRetries} retries: ${errorMessage}`,
          );
        } else {
          // Schedule next retry with exponential backoff
          const delayMs = calculateDelay(newRetryCount);
          const nextRetryAt = new Date(Date.now() + delayMs);

          await db
            .update(eventsTable)
            .set({
              status: "failed",
              errorMessage,
              retryCount: newRetryCount,
              nextRetryAt,
            })
            .where(eq(eventsTable.id, row.id));

          logger.info(
            `[OutboxWorker] Event "${row.id}" (${row.event_type}) retry ${newRetryCount}/${maxRetries} scheduled in ${delayMs}ms`,
          );
        }
      }
    }

    return processed;
  }

  function start(): void {
    if (timer) return;
    stopped = false;
    logger.info(`[OutboxWorker] Started (poll=${pollIntervalMs}ms, maxRetries=${maxRetries})`);

    timer = setInterval(async () => {
      if (processing) return; // Skip if previous batch still running
      processing = true;
      try {
        await processBatch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[OutboxWorker] Poll error: ${msg}`);
      } finally {
        processing = false;
      }
    }, pollIntervalMs);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Wait for in-progress processing to finish
    while (processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    logger.info("[OutboxWorker] Stopped");
  }

  return { start, stop, processBatch };
}
