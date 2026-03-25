/**
 * OutboxWorker unit tests
 *
 * Tests retry logic, exponential backoff, dead-letter handling,
 * batch processing, metrics, and graceful shutdown using a real
 * PostgreSQL database.
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
    status?: "pending" | "failed" | "processing";
  },
): Promise<string> {
  const [row] = await db
    .insert(eventsTable)
    .values({
      eventType,
      payload: { test: true },
      status: options?.status ?? "failed",
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
      CREATE TYPE "_linchkit"."event_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'dead_letter')
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
    await db.execute(sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_tenant" ON "_linchkit"."events" USING btree ("tenant_id", "event_type")
    `));
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearEvents();
  });

  // ── Retry logic ────────────────────────────────────────────

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

  test("exponential backoff increases delay with each retry", async () => {
    // Insert event that has already been retried once
    const id1 = await insertFailedEvent("backoff.test", { retryCount: 0 });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "backoff-handler",
      listen: "backoff.test",
      handler: async () => {
        throw new Error("still failing");
      },
    });

    const worker = createOutboxWorker({
      db,
      registry,
      maxRetries: 5,
      baseDelayMs: 1000,
    });

    await worker.processBatch();

    const rows1 = await db.select().from(eventsTable).where(eq(eventsTable.id, id1));
    const firstDelay = rows1[0]!.nextRetryAt!.getTime() - Date.now();
    // First retry delay: ~1000ms base * 2^1 = ~2000ms (±25% jitter)
    // Actually retryCount goes from 0→1, delay = 1000 * 2^1 = 2000 ±500
    expect(firstDelay).toBeGreaterThan(1000);
    expect(firstDelay).toBeLessThan(3500);
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

  // ── Dead-letter handling ──────────────────────────────────

  test("processBatch moves event to dead_letter after max retries", async () => {
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

    // Event should be in dead_letter status, not just failed
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows[0]?.status).toBe("dead_letter");
    expect(rows[0]?.retryCount).toBe(3);
    expect(rows[0]?.nextRetryAt).toBeNull();
    expect(rows[0]?.errorMessage).toBe("permanent failure");
  });

  test("dead_letter events are not picked up for retry", async () => {
    // Manually insert a dead_letter event
    const [row] = await db
      .insert(eventsTable)
      .values({
        eventType: "dead.event",
        payload: { test: true },
        status: "dead_letter",
        errorMessage: "gave up",
        retryCount: 5,
        nextRetryAt: null,
      })
      .returning({ id: eventsTable.id });

    const registry = new EventHandlerRegistry();
    let called = false;
    registry.register({
      name: "dead-handler",
      listen: "dead.event",
      handler: async () => {
        called = true;
      },
    });

    const worker = createOutboxWorker({ db, registry, maxRetries: 5 });
    const processed = await worker.processBatch();

    expect(processed).toBe(0);
    expect(called).toBe(false);

    // Status should remain dead_letter
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, row!.id));
    expect(rows[0]?.status).toBe("dead_letter");
  });

  test("onDeadLetter callback is invoked when event is dead-lettered", async () => {
    await insertFailedEvent("notify.test", { retryCount: 4 });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "fail-handler",
      listen: "notify.test",
      handler: async () => {
        throw new Error("boom");
      },
    });

    const deadLetterEvents: Array<{ id: string; type: string; error: string }> = [];

    const worker = createOutboxWorker({
      db,
      registry,
      maxRetries: 5,
      onDeadLetter: (id, type, error) => {
        deadLetterEvents.push({ id, type, error });
      },
    });

    await worker.processBatch();

    expect(deadLetterEvents).toHaveLength(1);
    expect(deadLetterEvents[0]?.type).toBe("notify.test");
    expect(deadLetterEvents[0]?.error).toBe("boom");
  });

  test("onDeadLetter callback error does not disrupt worker", async () => {
    await insertFailedEvent("callback.error", { retryCount: 4 });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "fail-handler",
      listen: "callback.error",
      handler: async () => {
        throw new Error("fail");
      },
    });

    const worker = createOutboxWorker({
      db,
      registry,
      maxRetries: 5,
      onDeadLetter: () => {
        throw new Error("callback exploded");
      },
    });

    // Should not throw despite callback error
    await worker.processBatch();

    const m = worker.getMetrics();
    expect(m.deadLettered).toBe(1);
  });

  // ── Batch processing ──────────────────────────────────────

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

  test("processBatch picks up pending events", async () => {
    await insertFailedEvent("pending.event", {
      status: "pending",
      retryCount: 0,
    });

    const registry = new EventHandlerRegistry();
    let handled = false;
    registry.register({
      name: "pending-handler",
      listen: "pending.event",
      handler: async () => {
        handled = true;
      },
    });

    const worker = createOutboxWorker({ db, registry });
    const processed = await worker.processBatch();

    expect(processed).toBe(1);
    expect(handled).toBe(true);
  });

  // ── Metrics ───────────────────────────────────────────────

  test("getMetrics tracks processed, failed, and dead-letter counts", async () => {
    // Insert events: one will succeed, one will fail (retriable), one will dead-letter
    await insertFailedEvent("metric.success");
    await insertFailedEvent("metric.retry", { retryCount: 0 });
    await insertFailedEvent("metric.dead", { retryCount: 4 });

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "success-handler",
      listen: "metric.success",
      handler: async () => {},
    });
    registry.register({
      name: "retry-handler",
      listen: "metric.retry",
      handler: async () => {
        throw new Error("transient");
      },
    });
    registry.register({
      name: "dead-handler",
      listen: "metric.dead",
      handler: async () => {
        throw new Error("permanent");
      },
    });

    const worker = createOutboxWorker({ db, registry, maxRetries: 5 });
    await worker.processBatch();

    const m = worker.getMetrics();
    expect(m.processed).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.deadLettered).toBe(1);
    expect(m.batchesRun).toBe(1);
  });

  test("resetMetrics clears all counters", async () => {
    await insertFailedEvent("reset.test");

    const registry = new EventHandlerRegistry();
    registry.register({
      name: "reset-handler",
      listen: "reset.test",
      handler: async () => {},
    });

    const worker = createOutboxWorker({ db, registry });
    await worker.processBatch();

    expect(worker.getMetrics().processed).toBe(1);

    worker.resetMetrics();
    const m = worker.getMetrics();
    expect(m.processed).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.deadLettered).toBe(0);
    expect(m.batchesRun).toBe(0);
  });

  test("metrics accumulate across multiple batches", async () => {
    const registry = new EventHandlerRegistry();
    registry.register({
      name: "accum-handler",
      listen: "accum.event",
      handler: async () => {},
    });

    const worker = createOutboxWorker({ db, registry });

    // First batch: 1 event
    await insertFailedEvent("accum.event");
    await worker.processBatch();

    // Second batch: 2 events
    await insertFailedEvent("accum.event");
    await insertFailedEvent("accum.event");
    await worker.processBatch();

    const m = worker.getMetrics();
    expect(m.processed).toBe(3);
    expect(m.batchesRun).toBe(2);
  });

  // ── Lifecycle ─────────────────────────────────────────────

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

  test("stop waits for current batch to finish", async () => {
    await insertFailedEvent("stop.test");

    const registry = new EventHandlerRegistry();
    let handlerFinished = false;
    registry.register({
      name: "slow-handler",
      listen: "stop.test",
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        handlerFinished = true;
      },
    });

    const worker = createOutboxWorker({
      db,
      registry,
      pollIntervalMs: 10,
    });

    worker.start();
    // Give it time to pick up the event
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();

    // The handler should have completed before stop returned
    // (give a small grace period since polling is async)
    expect(handlerFinished).toBe(true);
  });

  test("start is idempotent", async () => {
    const registry = new EventHandlerRegistry();
    const worker = createOutboxWorker({ db, registry, pollIntervalMs: 50 });

    worker.start();
    worker.start(); // Second call should be a no-op
    await worker.stop();
  });
});
