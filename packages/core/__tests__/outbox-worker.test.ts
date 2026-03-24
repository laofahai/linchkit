/**
 * OutboxWorker unit tests
 *
 * Tests retry logic, exponential backoff, and batch processing
 * using a real PostgreSQL database (same as PersistentEventBus tests).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EventHandlerRegistry } from "../src/event/event-bus";
import { createOutboxWorker } from "../src/event/outbox-worker";
import {
  eventsTable,
} from "../src/persistence/system-tables";
import { closeDatabase, createDatabase } from "../src/server-entry";

// Use test DB on port 5434 (docker-compose postgres-test)
const TEST_DB_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

let db: PostgresJsDatabase;
let dbAvailable = false;

/** Connection check */
async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: TEST_DB_URL });
    await testDb.execute(sql`SELECT 1`);
    await closeDatabase();
    return true;
  } catch {
    return false;
  }
}

dbAvailable = await canConnect();
if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping OutboxWorker tests");
}

/** Insert a failed event directly into the DB for testing */
async function insertFailedEvent(
  eventType: string,
  options?: {
    retryCount?: number;
    nextRetryAt?: Date | null;
    errorMessage?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(eventsTable)
    .values({
      eventType,
      payload: { test: true },
      status: "failed",
      errorMessage: options?.errorMessage ?? "test error",
      retryCount: options?.retryCount ?? 0,
      nextRetryAt: options?.nextRetryAt ?? null,
    })
    .returning({ id: eventsTable.id });
  return row?.id;
}

/** Clear all events between tests */
async function clearEvents(): Promise<void> {
  await db.delete(eventsTable);
}

describe.skipIf(!dbAvailable)("OutboxWorker", () => {
  beforeAll(async () => {
    db = createDatabase({ url: TEST_DB_URL });

    // Drop and recreate system tables for clean state
    await db.execute(sql.raw('DROP TABLE IF EXISTS "_linchkit"."events" CASCADE'));
    await db.execute(sql.raw('DROP TYPE IF EXISTS "_linchkit"."event_status" CASCADE'));

    // Create system tables via raw SQL (test fixture)
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS "_linchkit"'));
    await db.execute(sql.raw(`
      CREATE TYPE "_linchkit"."event_status" AS ENUM('pending', 'processing', 'completed', 'failed')
    `));
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "_linchkit"."events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" varchar(255),
        "event_type" varchar(255) NOT NULL,
        "payload" jsonb,
        "source_action" varchar(255),
        "source_execution_id" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "processed_at" timestamp,
        "status" "_linchkit"."event_status" DEFAULT 'pending' NOT NULL,
        "error_message" text,
        "retry_count" integer DEFAULT 0 NOT NULL,
        "next_retry_at" timestamp
      )
    `));
    await db.execute(sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_type_status" ON "_linchkit"."events" USING btree ("event_type", "status")
    `));
    await db.execute(sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_retry" ON "_linchkit"."events" USING btree ("status", "next_retry_at")
    `));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearEvents();
  });

  test("processBatch retries a failed event successfully", async () => {
    const id = await insertFailedEvent("order.created");

    const registry = new EventHandlerRegistry();
    let handlerCalled = false;
    registry.register({
      name: "test-handler",
      listen: "order.created",
      handler: async () => {
        handlerCalled = true;
      },
    });

    const worker = createOutboxWorker({ db, registry, maxRetries: 3 });
    const processed = await worker.processBatch();

    expect(processed).toBe(1);
    expect(handlerCalled).toBe(true);

    // Verify event is now completed
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.processedAt).toBeTruthy();
  });

  test("processBatch schedules retry on handler failure", async () => {
    const id = await insertFailedEvent("order.created", { retryCount: 0 });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "failing-handler",
      listen: "order.created",
      handler: async () => {
        throw new Error("handler still broken");
      },
    });

    const worker = createOutboxWorker({
      db,
      registry,
      maxRetries: 3,
      baseDelayMs: 100,
    });
    await worker.processBatch();

    // Event should remain failed with incremented retryCount and scheduled nextRetryAt
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.retryCount).toBe(1);
    expect(rows[0]?.nextRetryAt).toBeTruthy();
    expect(rows[0]?.errorMessage).toBe("handler still broken");
  });

  test("processBatch gives up after max retries", async () => {
    const id = await insertFailedEvent("order.created", {
      retryCount: 2, // Already tried twice
    });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "always-fails",
      listen: "order.created",
      handler: async () => {
        throw new Error("permanent failure");
      },
    });

    const worker = createOutboxWorker({ db, registry, maxRetries: 3 });
    await worker.processBatch();

    // retryCount should be 3 (maxRetries), nextRetryAt should be null (no more retries)
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.retryCount).toBe(3);
    expect(rows[0]?.nextRetryAt).toBeNull();
  });

  test("processBatch skips events with future nextRetryAt", async () => {
    const futureDate = new Date(Date.now() + 60_000); // 1 min in the future
    await insertFailedEvent("order.created", {
      retryCount: 1,
      nextRetryAt: futureDate,
    });

    const registry = new EventHandlerRegistry();
    let called = false;
    registry.register({
      name: "test-handler",
      listen: "order.created",
      handler: async () => {
        called = true;
      },
    });

    const worker = createOutboxWorker({ db, registry });
    const processed = await worker.processBatch();

    expect(processed).toBe(0);
    expect(called).toBe(false);
  });

  test("processBatch respects batchSize", async () => {
    // Insert 5 failed events
    for (let i = 0; i < 5; i++) {
      await insertFailedEvent(`batch.event.${i}`);
    }

    const registry = new EventHandlerRegistry();
    // Register handlers for all event types
    for (let i = 0; i < 5; i++) {
      registry.register({
        name: `handler-${i}`,
        listen: `batch.event.${i}`,
        handler: async () => {},
      });
    }

    const worker = createOutboxWorker({ db, registry, batchSize: 2 });
    const processed = await worker.processBatch();

    // Should process at most batchSize events
    expect(processed).toBeLessThanOrEqual(2);
  });

  test("processBatch returns 0 when no retryable events", async () => {
    const registry = new EventHandlerRegistry();
    const worker = createOutboxWorker({ db, registry });
    const processed = await worker.processBatch();
    expect(processed).toBe(0);
  });

  test("start and stop lifecycle", async () => {
    const registry = new EventHandlerRegistry();
    const worker = createOutboxWorker({
      db,
      registry,
      pollIntervalMs: 50,
    });

    worker.start();
    // Let it poll a couple of times
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();
    // Should not throw
  });
});
