/**
 * Persistent Event Bus
 *
 * Extends the in-memory EventBus with database persistence.
 * When a database is available, events are stored in the
 * `_linchkit_events` system table with status tracking.
 * Falls back to pure in-memory behavior when no DB is provided.
 *
 * Unlike the base EventBus which fires async handlers in a
 * fire-and-forget manner, PersistentEventBus awaits ALL handlers
 * (both sync and async) before updating status. This ensures
 * accurate persistence of handler completion/failure.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import { consoleLogger } from "./console-logger";
import { EventBus, EventHandlerRegistry, matchesFilter } from "./event-bus";
import { eventsTable } from "./system-tables";

const DEFAULT_PRIORITY = 100;

export class PersistentEventBus extends EventBus {
  private readonly db: PostgresJsDatabase;
  private readonly persistLogger: Logger;

  constructor(
    db: PostgresJsDatabase,
    registry: EventHandlerRegistry,
    maxEmitDepth?: number,
    logger: Logger = consoleLogger,
  ) {
    super(registry, maxEmitDepth, logger);
    this.db = db;
    this.persistLogger = logger;
  }

  /**
   * Emit an event with database persistence.
   *
   * Overrides the base EventBus.emit() to:
   * 1. Insert event into `_linchkit_events` with status 'pending'
   * 2. Execute ALL handlers (both sync and async) with full await
   * 3. Update status to 'completed' if all succeed, 'failed' if any reject
   *
   * This does NOT call super.emit() — it manages handler execution
   * directly to ensure async handlers are properly awaited for
   * accurate persistence tracking.
   */
  override async emit(event: EventRecord): Promise<void> {
    // Guard against infinite recursion (same logic as base class)
    if (this.emitDepth >= this.maxEmitDepth) {
      throw new Error(
        `EventBus max emit depth (${this.maxEmitDepth}) exceeded for event "${event.type}". Possible infinite loop.`,
      );
    }

    // Persist event with 'pending' status
    let rowId: string | undefined;
    try {
      const [inserted] = await this.db
        .insert(eventsTable)
        .values({
          eventType: event.type,
          payload: event.payload as Record<string, unknown>,
          sourceAction: (event.payload?.action as string) ?? null,
          sourceExecutionId: event.executionId ?? null,
          status: "pending",
        })
        .returning({ id: eventsTable.id });

      rowId = inserted?.id;
    } catch (err) {
      // Log persistence failure but don't block event processing
      const msg = err instanceof Error ? err.message : String(err);
      this.persistLogger.warn(
        `[PersistentEventBus] Failed to persist event "${event.type}": ${msg}`,
      );
    }

    this.emitDepth++;
    try {
      // Record the event in the in-memory log
      this.eventLog.push(event);

      // Find matching handlers
      const handlers = this.registry.getByEvent(event.type);

      // Apply filters
      const matched = handlers.filter((h) => {
        if (!h.filter) return true;
        return matchesFilter(event.payload, h.filter);
      });

      // Sort by priority (lower number = higher priority)
      matched.sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));

      // Build handler context
      const ctx = this.createHandlerContext();

      // Execute all handlers, awaiting every one (including async ones).
      // Sync handlers run sequentially (error stops chain, same as base).
      // Async handlers are collected and awaited after sync execution.
      const asyncPromises: Promise<void>[] = [];
      let syncError: unknown = null;

      for (const handler of matched) {
        if (syncError) break;

        // Shallow copy event record so handlers cannot mutate shared state
        const eventCopy = { ...event, payload: { ...event.payload } };

        if (handler.async) {
          // Collect async handler promises to await later
          asyncPromises.push(
            handler.handler(eventCopy, ctx).catch((err) => {
              this.logger.warn(
                `[PersistentEventBus] Async handler "${handler.name}" failed for event "${event.type}": ${err}`,
              );
              throw err;
            }),
          );
        } else {
          // Sync: execute in sequence, capture error
          try {
            await handler.handler(eventCopy, ctx);
          } catch (err) {
            syncError = err;
          }
        }
      }

      // If a sync handler failed, mark as failed and re-throw
      if (syncError) {
        if (rowId) {
          const errorMessage = syncError instanceof Error ? syncError.message : String(syncError);
          await this.updateStatus(rowId, "failed", errorMessage);
        }
        throw syncError;
      }

      // Await all async handlers
      if (asyncPromises.length > 0) {
        const results = await Promise.allSettled(asyncPromises);
        const firstRejection = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );

        if (firstRejection) {
          // At least one async handler failed
          if (rowId) {
            const errorMessage =
              firstRejection.reason instanceof Error
                ? firstRejection.reason.message
                : String(firstRejection.reason);
            await this.updateStatus(rowId, "failed", errorMessage);
          }
          return;
        }
      }

      // All handlers succeeded
      if (rowId) {
        await this.updateStatus(rowId, "completed");
      }
    } finally {
      this.emitDepth--;
    }
  }

  /** Update event status in the database */
  private async updateStatus(
    id: string,
    status: "completed" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(eventsTable)
        .set({
          status,
          processedAt: new Date(),
          ...(errorMessage ? { errorMessage } : {}),
        })
        .where(eq(eventsTable.id, id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.persistLogger.warn(
        `[PersistentEventBus] Failed to update event status to "${status}": ${msg}`,
      );
    }
  }
}

/** Create a PersistentEventBus with its own EventHandlerRegistry */
export function createPersistentEventBus(db: PostgresJsDatabase): {
  registry: EventHandlerRegistry;
  bus: PersistentEventBus;
} {
  const registry = new EventHandlerRegistry();
  const bus = new PersistentEventBus(db, registry);
  return { registry, bus };
}
