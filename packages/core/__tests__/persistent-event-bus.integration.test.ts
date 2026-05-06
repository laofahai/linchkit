/**
 * Integration tests for PersistentEventBus against a real PostgreSQL database.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL env var to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 *
 * Skips gracefully when no database is available (CI without PG won't fail).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { EventHandlerDefinition, EventRecord } from "@linchkit/core";
import {
  closeDatabase,
  createDatabase,
  createPersistentEventBus,
  eventsTable,
} from "@linchkit/core/server";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

// ── Helpers ──────────────────────────────────────────────────

function makeEvent(type: string, payload: Record<string, unknown> = {}): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: crypto.randomUUID(),
    payload,
  };
}

function makeHandler(
  overrides: Partial<EventHandlerDefinition> & { name: string; listen: string | string[] },
): EventHandlerDefinition {
  return {
    handler: async () => {},
    ...overrides,
  };
}

// ── Connection check ─────────────────────────────────────────

let db: PostgresJsDatabase | null = null;

/** Safe accessor for db — avoids non-null assertions in tests */
function getDb(): PostgresJsDatabase {
  if (!db) throw new Error("Database not initialized");
  return db;
}

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    await closeDatabase();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping PersistentEventBus integration tests");
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("PersistentEventBus (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // Drop system tables if they exist from a previous run
    await db.execute(sql.raw('DROP TABLE IF EXISTS "_linchkit"."events" CASCADE'));
    await db.execute(sql.raw('DROP TYPE IF EXISTS "_linchkit"."event_status" CASCADE'));

    // Create system tables via raw SQL (test fixture)
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS "_linchkit"'));
    await db.execute(
      sql.raw(`
      CREATE TYPE "_linchkit"."event_status" AS ENUM('pending', 'processing', 'completed', 'failed')
    `),
    );
    await db.execute(
      sql.raw(`
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
        "next_retry_at" timestamp,
        "meta" jsonb
      )
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_type_status" ON "_linchkit"."events" USING btree ("event_type", "status")
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_retry" ON "_linchkit"."events" USING btree ("status", "next_retry_at")
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE INDEX IF NOT EXISTS "idx_events_tenant" ON "_linchkit"."events" USING btree ("tenant_id", "event_type")
    `),
    );
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw('DROP TABLE IF EXISTS "_linchkit"."events" CASCADE'));
      await db.execute(sql.raw('DROP TYPE IF EXISTS "_linchkit"."event_status" CASCADE'));
      await closeDatabase();
    }
  });

  afterEach(async () => {
    if (db) {
      await db.execute(sql.raw('TRUNCATE TABLE "_linchkit"."events"'));
    }
  });

  // ── 1. Event emission — persisted with status 'pending' ──

  test("emit — event is persisted to DB and completed when no handlers registered", async () => {
    const { bus } = createPersistentEventBus(getDb());

    // Register a slow async handler so we can check persistence happened
    // before handler completes (though emit awaits all handlers in PersistentEventBus)
    await bus.emit(makeEvent("order.created", { action: "create_order", orderId: "123" }));

    // Query the events table directly
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.eventType).toBe("order.created");
    expect(row.payload).toEqual({ action: "create_order", orderId: "123" });
    expect(row.sourceAction).toBe("create_order");
    expect(row.status).toBe("completed"); // No handlers → completed immediately
    expect(row.id).toBeDefined();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("emit — event without handlers is persisted and completed", async () => {
    const { bus } = createPersistentEventBus(getDb());

    await bus.emit(makeEvent("unhandled.event"));

    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("unhandled.event");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].errorMessage).toBeNull();
  });

  // ── 2. Subscription + processing — handler called, status updated ──

  test("emit with sync handler — handler called and status becomes 'completed'", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    const received: EventRecord[] = [];

    registry.register(
      makeHandler({
        name: "order-listener",
        listen: "order.created",
        handler: async (event) => {
          received.push(event);
        },
      }),
    );

    await bus.emit(makeEvent("order.created", { action: "create_order" }));

    // Handler was called
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("order.created");

    // DB status is 'completed'
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].processedAt).toBeInstanceOf(Date);
    expect(rows[0].errorMessage).toBeNull();
  });

  test("emit with async handler — handler awaited and status becomes 'completed'", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    let asyncFinished = false;

    registry.register(
      makeHandler({
        name: "async-processor",
        listen: "task.completed",
        async: true,
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          asyncFinished = true;
        },
      }),
    );

    await bus.emit(makeEvent("task.completed"));

    // Async handler was fully awaited
    expect(asyncFinished).toBe(true);

    // DB status is 'completed'
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  // ── 3. Error handling — handler throws, status 'failed' + errorMessage ──

  test("sync handler error — status becomes 'failed' with errorMessage", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());

    registry.register(
      makeHandler({
        name: "failing-handler",
        listen: "payment.failed",
        handler: async () => {
          throw new Error("Payment gateway timeout");
        },
      }),
    );

    // Sync handler errors are re-thrown
    await expect(bus.emit(makeEvent("payment.failed"))).rejects.toThrow("Payment gateway timeout");

    // DB records the failure
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toBe("Payment gateway timeout");
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  test("async handler error — status becomes 'failed' with errorMessage", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());

    registry.register(
      makeHandler({
        name: "failing-async",
        listen: "notification.send",
        async: true,
        handler: async () => {
          throw new Error("SMTP connection refused");
        },
      }),
    );

    // Async handler failures don't throw from emit()
    await bus.emit(makeEvent("notification.send"));

    // DB records the failure
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toBe("SMTP connection refused");
  });

  // ── 4. Multiple subscribers ──────────────────────────────

  test("multiple sync handlers — all execute in priority order", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    const order: string[] = [];

    registry.register(
      makeHandler({
        name: "audit-logger",
        listen: "record.updated",
        priority: 200,
        handler: async () => {
          order.push("audit");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "cache-invalidator",
        listen: "record.updated",
        priority: 50,
        handler: async () => {
          order.push("cache");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "webhook-notifier",
        listen: "record.updated",
        priority: 150,
        handler: async () => {
          order.push("webhook");
        },
      }),
    );

    await bus.emit(makeEvent("record.updated"));

    // Handlers executed in priority order (lower number = higher priority)
    expect(order).toEqual(["cache", "webhook", "audit"]);

    // Single event row in DB, marked completed
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  test("multiple async handlers — all awaited, one failure marks event failed", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    const executed: string[] = [];

    registry.register(
      makeHandler({
        name: "ok-handler",
        listen: "batch.process",
        async: true,
        priority: 1,
        handler: async () => {
          executed.push("ok");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "failing-handler",
        listen: "batch.process",
        async: true,
        priority: 2,
        handler: async () => {
          executed.push("fail");
          throw new Error("batch item error");
        },
      }),
    );

    await bus.emit(makeEvent("batch.process"));

    // Both handlers ran
    expect(executed).toContain("ok");
    expect(executed).toContain("fail");

    // Event marked as failed due to one rejection
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toBe("batch item error");
  });

  test("mixed sync + async handlers — sync error stops chain", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    const executed: string[] = [];

    registry.register(
      makeHandler({
        name: "sync-fail",
        listen: "mixed.event",
        priority: 1,
        handler: async () => {
          executed.push("sync-fail");
          throw new Error("sync boom");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "after-sync",
        listen: "mixed.event",
        priority: 2,
        async: true,
        handler: async () => {
          executed.push("should-not-run");
        },
      }),
    );

    await expect(bus.emit(makeEvent("mixed.event"))).rejects.toThrow("sync boom");

    // Only the first sync handler ran; the chain stopped
    expect(executed).toEqual(["sync-fail"]);

    // DB shows failed
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toBe("sync boom");
  });

  // ── 5. Event query — verify events queryable from DB ─────

  test("multiple events — each independently persisted and queryable", async () => {
    const { bus } = createPersistentEventBus(getDb());

    await bus.emit(makeEvent("order.created", { action: "create_order" }));
    await bus.emit(makeEvent("order.updated", { action: "update_order" }));
    await bus.emit(makeEvent("order.created", { action: "create_order" }));

    // All 3 events persisted
    const allRows = await db?.select().from(eventsTable);
    expect(allRows).toHaveLength(3);

    // Filter by event type
    const createdRows = await db
      ?.select()
      .from(eventsTable)
      .where(eq(eventsTable.eventType, "order.created"));
    expect(createdRows).toHaveLength(2);

    const updatedRows = await db
      ?.select()
      .from(eventsTable)
      .where(eq(eventsTable.eventType, "order.updated"));
    expect(updatedRows).toHaveLength(1);
  });

  test("events queryable by status", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());

    // This handler will fail for specific events
    registry.register(
      makeHandler({
        name: "conditional-fail",
        listen: "status.test",
        handler: async (event) => {
          if (event.payload.shouldFail) {
            throw new Error("intentional failure");
          }
        },
      }),
    );

    // Emit a successful event
    await bus.emit(makeEvent("status.test", { shouldFail: false }));

    // Emit a failing event (sync handler throws, so emit rejects)
    try {
      await bus.emit(makeEvent("status.test", { shouldFail: true }));
    } catch {
      // Expected
    }

    // Query by status
    const completed = await db
      ?.select()
      .from(eventsTable)
      .where(eq(eventsTable.status, "completed"));
    expect(completed).toHaveLength(1);

    const failed = await db?.select().from(eventsTable).where(eq(eventsTable.status, "failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0].errorMessage).toBe("intentional failure");
  });

  test("event payload and metadata are fully persisted", async () => {
    const { bus } = createPersistentEventBus(getDb());

    const event = makeEvent("audit.action", {
      action: "approve_invoice",
      invoiceId: "INV-001",
      amount: 1500,
      approved: true,
    });
    event.executionId = "exec-abc-123";

    await bus.emit(event);

    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.eventType).toBe("audit.action");
    expect(row.sourceAction).toBe("approve_invoice");
    expect(row.sourceExecutionId).toBe("exec-abc-123");
    expect((row.payload as Record<string, unknown>).invoiceId).toBe("INV-001");
    expect((row.payload as Record<string, unknown>).amount).toBe(1500);
    expect((row.payload as Record<string, unknown>).approved).toBe(true);
  });

  // ── 6. Edge cases ────────────────────────────────────────

  test("handler filter — only matching handlers are invoked", async () => {
    const { registry, bus } = createPersistentEventBus(getDb());
    const received: string[] = [];

    registry.register(
      makeHandler({
        name: "vip-only",
        listen: "order.created",
        filter: { customerType: "vip" },
        handler: async () => {
          received.push("vip-handler");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "all-orders",
        listen: "order.created",
        handler: async () => {
          received.push("all-handler");
        },
      }),
    );

    // Non-VIP order: only all-orders handler fires
    await bus.emit(makeEvent("order.created", { customerType: "regular" }));
    expect(received).toEqual(["all-handler"]);

    // Reset
    received.length = 0;

    // VIP order: both handlers fire
    await bus.emit(makeEvent("order.created", { customerType: "vip" }));
    expect(received).toEqual(["vip-handler", "all-handler"]);

    // Both events persisted
    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(2);
  });

  test("event with null payload.action — sourceAction is null", async () => {
    const { bus } = createPersistentEventBus(getDb());

    await bus.emit(makeEvent("custom.event", { data: "no action field" }));

    const rows = await db?.select().from(eventsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceAction).toBeNull();
  });
});
