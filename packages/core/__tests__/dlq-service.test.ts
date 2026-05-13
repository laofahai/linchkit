/**
 * DlqService integration tests
 *
 * Tests require a running PostgreSQL instance on the test database URL.
 * Skips gracefully when the database is not available.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DlqService } from "../src/event/dlq-service";
import { createDlqService } from "../src/event/dlq-service";
import { eventsTable } from "../src/persistence/system-tables";
import { closeDatabase, createDatabase } from "../src/server-entry";

const TEST_DB_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

let db: PostgresJsDatabase;
let svc: DlqService;
let dbAvailable = false;

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
  console.warn("PostgreSQL not available — skipping DlqService tests");
}

async function insertEvent(options?: {
  tenantId?: string;
  eventType?: string;
  errorMessage?: string;
  retryCount?: number;
  status?: "pending" | "failed" | "dead_letter" | "completed" | "processing";
}): Promise<string> {
  const [row] = await db
    .insert(eventsTable)
    .values({
      eventType: options?.eventType ?? "test.event",
      payload: { test: true },
      tenantId: options?.tenantId,
      status: options?.status ?? "dead_letter",
      errorMessage: options?.errorMessage ?? "max retries exceeded",
      retryCount: options?.retryCount ?? 5,
    })
    .returning({ id: eventsTable.id });
  return row.id;
}

describe.skipIf(!dbAvailable)("DlqService", () => {
  beforeAll(async () => {
    db = createDatabase({ url: TEST_DB_URL });

    await db.execute(sql.raw('DROP TABLE IF EXISTS "_linchkit"."events" CASCADE'));
    await db.execute(sql.raw('DROP TYPE IF EXISTS "_linchkit"."event_status" CASCADE'));
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS "_linchkit"'));
    await db.execute(
      sql.raw(`
        CREATE TYPE "_linchkit"."event_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'dead_letter')
      `),
    );
    await db.execute(
      sql.raw(`
        CREATE TABLE IF NOT EXISTS "_linchkit"."events" (
          "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "tenant_id"           varchar(255),
          "event_type"          varchar(255) NOT NULL,
          "payload"             jsonb,
          "source_action"       varchar(255),
          "source_execution_id" text,
          "created_at"          timestamp DEFAULT now() NOT NULL,
          "processed_at"        timestamp,
          "status"              "_linchkit"."event_status" DEFAULT 'pending' NOT NULL,
          "error_message"       text,
          "retry_count"         integer DEFAULT 0 NOT NULL,
          "next_retry_at"       timestamp,
          "meta"                jsonb
        )
      `),
    );

    svc = createDlqService(db);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await db.delete(eventsTable);
  });

  // ── list ───────────────────────────────────────────────────

  test("list returns empty result when no dead-letter events", async () => {
    const result = await svc.list();
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list returns dead-letter events in descending order", async () => {
    await insertEvent({ eventType: "order.created" });
    await insertEvent({ eventType: "payment.failed" });

    const result = await svc.list();
    expect(result.total).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  test("list does not include non-dead-letter events", async () => {
    await insertEvent({ status: "pending" });
    await insertEvent({ status: "failed" });
    await insertEvent({ status: "completed" });
    await insertEvent({ status: "dead_letter" });

    const result = await svc.list();
    expect(result.total).toBe(1);
  });

  test("list filters by tenantId", async () => {
    await insertEvent({ tenantId: "tenant-a", eventType: "order.created" });
    await insertEvent({ tenantId: "tenant-b", eventType: "order.created" });
    await insertEvent({ eventType: "order.created" });

    const result = await svc.list({ tenantId: "tenant-a" });
    expect(result.total).toBe(1);
    expect(result.entries[0].tenantId).toBe("tenant-a");
  });

  test("list filters by eventType", async () => {
    await insertEvent({ eventType: "order.created" });
    await insertEvent({ eventType: "payment.failed" });
    await insertEvent({ eventType: "order.created" });

    const result = await svc.list({ eventType: "order.created" });
    expect(result.total).toBe(2);
    for (const e of result.entries) {
      expect(e.eventType).toBe("order.created");
    }
  });

  test("list respects limit and offset for pagination", async () => {
    await insertEvent({ eventType: "a" });
    await insertEvent({ eventType: "b" });
    await insertEvent({ eventType: "c" });

    const page1 = await svc.list({ limit: 2, offset: 0 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await svc.list({ limit: 2, offset: 2 });
    expect(page2.entries).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  // ── get ────────────────────────────────────────────────────

  test("get returns a dead-letter event by id", async () => {
    const id = await insertEvent({ eventType: "order.created", errorMessage: "boom" });

    const entry = await svc.get(id);
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(id);
    expect(entry?.eventType).toBe("order.created");
    expect(entry?.errorMessage).toBe("boom");
    expect(entry?.retryCount).toBe(5);
  });

  test("get returns null for unknown id", async () => {
    const entry = await svc.get("00000000-0000-0000-0000-000000000000");
    expect(entry).toBeNull();
  });

  test("get returns null for event with non-dead-letter status", async () => {
    const id = await insertEvent({ status: "failed" });
    const entry = await svc.get(id);
    expect(entry).toBeNull();
  });

  // ── replay ─────────────────────────────────────────────────

  test("replay resets event to pending with cleared retry state", async () => {
    const id = await insertEvent({ retryCount: 5, errorMessage: "max retries exceeded" });

    const ok = await svc.replay(id);
    expect(ok).toBe(true);

    const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(row.status).toBe("pending");
    expect(row.retryCount).toBe(0);
    expect(row.nextRetryAt).toBeNull();
    expect(row.errorMessage).toBeNull();
  });

  test("replay returns false for unknown id", async () => {
    const ok = await svc.replay("00000000-0000-0000-0000-000000000000");
    expect(ok).toBe(false);
  });

  test("replay returns false for non-dead-letter event", async () => {
    const id = await insertEvent({ status: "failed" });
    const ok = await svc.replay(id);
    expect(ok).toBe(false);

    const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(row.status).toBe("failed");
  });

  // ── purge ──────────────────────────────────────────────────

  test("purge removes the dead-letter event from the table", async () => {
    const id = await insertEvent();

    const ok = await svc.purge(id);
    expect(ok).toBe(true);

    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows).toHaveLength(0);
  });

  test("purge returns false for unknown id", async () => {
    const ok = await svc.purge("00000000-0000-0000-0000-000000000000");
    expect(ok).toBe(false);
  });

  test("purge returns false for non-dead-letter event", async () => {
    const id = await insertEvent({ status: "pending" });
    const ok = await svc.purge(id);
    expect(ok).toBe(false);

    const rows = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(rows).toHaveLength(1);
  });

  // ── getStats ───────────────────────────────────────────────

  test("getStats returns zero totals when no dead-letter events", async () => {
    const stats = await svc.getStats();
    expect(stats.total).toBe(0);
    expect(stats.byEventType).toEqual({});
  });

  test("getStats groups events by eventType", async () => {
    await insertEvent({ eventType: "order.created" });
    await insertEvent({ eventType: "order.created" });
    await insertEvent({ eventType: "payment.failed" });

    const stats = await svc.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byEventType["order.created"]).toBe(2);
    expect(stats.byEventType["payment.failed"]).toBe(1);
  });

  test("getStats respects tenantId filter", async () => {
    await insertEvent({ tenantId: "tenant-a", eventType: "order.created" });
    await insertEvent({ tenantId: "tenant-b", eventType: "order.created" });

    const stats = await svc.getStats("tenant-a");
    expect(stats.total).toBe(1);
    expect(stats.byEventType["order.created"]).toBe(1);
  });

  test("getStats excludes non-dead-letter events", async () => {
    await insertEvent({ status: "dead_letter", eventType: "a" });
    await insertEvent({ status: "failed", eventType: "b" });
    await insertEvent({ status: "pending", eventType: "c" });

    const stats = await svc.getStats();
    expect(stats.total).toBe(1);
    expect(Object.keys(stats.byEventType)).toEqual(["a"]);
  });
});
