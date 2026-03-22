/**
 * Persistent Event Bus
 *
 * Extends the in-memory EventBus with database persistence.
 * When a database is available, events are stored in the
 * `_linchkit_events` system table with status tracking.
 * Falls back to pure in-memory behavior when no DB is provided.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import { consoleLogger } from "./console-logger";
import { EventBus, EventHandlerRegistry } from "./event-bus";
import { eventsTable } from "./system-tables";

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
   * 1. Insert event into `_linchkit_events` with status 'pending'
   * 2. Delegate to super.emit() for in-memory handler execution
   * 3. Update status to 'completed' or 'failed' based on outcome
   */
  override async emit(event: EventRecord): Promise<void> {
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
      this.persistLogger.warn(`[PersistentEventBus] Failed to persist event "${event.type}": ${msg}`);
    }

    // Execute in-memory handlers via parent class
    try {
      await super.emit(event);

      // Mark as completed
      if (rowId) {
        await this.updateStatus(rowId, "completed");
      }
    } catch (err) {
      // Mark as failed and re-throw
      if (rowId) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.updateStatus(rowId, "failed", errorMessage);
      }
      throw err;
    }
  }

  /** Update event status in the database */
  private async updateStatus(
    id: string,
    status: "completed" | "failed",
    _errorMessage?: string,
  ): Promise<void> {
    try {
      await this.db
        .update(eventsTable)
        .set({
          status,
          processedAt: new Date(),
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
