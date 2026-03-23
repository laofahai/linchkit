/**
 * Drizzle Transaction Manager
 *
 * Implements the TransactionManager interface using Drizzle ORM.
 * Wraps action handler execution in a PostgreSQL transaction and
 * persists collected events to _linchkit_events in the same tx
 * (Transactional Outbox pattern).
 *
 * After the transaction commits, events are picked up by OutboxWorker
 * for handler execution. This guarantees that:
 * - Business data and events are atomically consistent
 * - Events are never "orphaned" (data rolled back but event persisted)
 * - Events are never "lost" (data committed but event not persisted)
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DataProvider, PendingEvent, TransactionManager } from "./action-engine";
import type { DrizzleDataProvider } from "./drizzle-data-provider";
import { eventsTable } from "./system-tables";

export class DrizzleTransactionManager implements TransactionManager {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly dataProvider: DrizzleDataProvider,
  ) {}

  async runInTransaction<T>(
    fn: (txDataProvider: DataProvider) => Promise<T>,
    pendingEvents: PendingEvent[],
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Create a transactional copy of the data provider
      const txDb = tx as unknown as PostgresJsDatabase;
      const txProvider = this.dataProvider.withConnection(txDb);

      // Execute the handler with the transactional provider
      const result = await fn(txProvider);

      // Persist collected events within the same transaction
      if (pendingEvents.length > 0) {
        for (const event of pendingEvents) {
          await txDb.insert(eventsTable).values({
            eventType: event.type,
            tenantId: event.tenantId ?? null,
            payload: {
              ...event.payload,
              ...(event.traceId ? { _traceId: event.traceId } : {}),
            } as Record<string, unknown>,
            sourceAction: event.sourceAction ?? null,
            sourceExecutionId: event.sourceExecutionId ?? null,
            status: "pending",
          });
        }
      }

      return result;
    });
  }
}
