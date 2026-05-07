/**
 * Drizzle Transaction Manager
 *
 * Implements the TransactionManager interface using Drizzle ORM.
 * Wraps action handler execution in a PostgreSQL transaction and
 * persists collected events to _linchkit.events in the same tx
 * (Transactional Outbox pattern).
 *
 * After the transaction commits, events are picked up by OutboxWorker
 * for handler execution. This guarantees that:
 * - Business data and events are atomically consistent
 * - Events are never "orphaned" (data rolled back but event persisted)
 * - Events are never "lost" (data committed but event not persisted)
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DataProvider, PendingEvent, TransactionManager } from "../engine/action-engine";
import type { DrizzleDataProvider } from "./drizzle-data-provider";
import { eventsTable } from "./system-tables";

/**
 * Optional callback that wraps the bare transactional `DrizzleDataProvider`
 * before it is handed to the action handler. Used by the dev-wiring to
 * keep an `OverlayAwareDataProvider` in the transactional path so overlay
 * field values fold into `_extensions` end-to-end (issue #156). Default is
 * the identity function — no wrapper applied.
 */
export type WrapForTxFn = (txProvider: DrizzleDataProvider) => DataProvider;

export interface DrizzleTransactionManagerOptions {
  /**
   * Apply a wrapper (e.g. `OverlayAwareDataProvider`) around the
   * transaction-scoped data provider before passing it to the handler.
   * Defaults to identity. The wrapper itself must NOT call
   * `withConnection` again — the manager has already opened the tx.
   */
  wrapForTx?: WrapForTxFn;
}

export class DrizzleTransactionManager implements TransactionManager {
  private readonly db: PostgresJsDatabase;
  private readonly dataProvider: DrizzleDataProvider;
  private readonly wrapForTx: WrapForTxFn;

  constructor(
    db: PostgresJsDatabase,
    dataProvider: DrizzleDataProvider,
    options?: DrizzleTransactionManagerOptions,
  ) {
    this.db = db;
    this.dataProvider = dataProvider;
    this.wrapForTx = options?.wrapForTx ?? ((p) => p);
  }

  async runInTransaction<T>(
    fn: (txDataProvider: DataProvider) => Promise<T>,
    pendingEvents: PendingEvent[],
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Create a transactional copy of the data provider
      const txDb = tx as unknown as PostgresJsDatabase;
      const bareTxProvider = this.dataProvider.withConnection(txDb);
      // Apply the optional wrap (identity by default). Used by dev-wiring
      // to keep `OverlayAwareDataProvider` in the transactional path so
      // overlay field values fold into `_extensions` end-to-end.
      const txProvider = this.wrapForTx(bareTxProvider);

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
