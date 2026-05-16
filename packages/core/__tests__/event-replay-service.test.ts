/**
 * EventReplayService integration tests
 *
 * Tests require a running PostgreSQL instance on the test database URL.
 * Skips gracefully when the database is not available.
 *
 * Mirrors dlq-service.test.ts shape: real PostgreSQL on port 5434, raw DDL
 * fixture matching the events table schema.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createEventReplayService,
  EventHandlerRegistry,
  type EventReplayService,
} from "../src/event";
import { eventsTable } from "../src/persistence/system-tables";
import { closeDatabase, createDatabase } from "../src/server-entry";

const TEST_DB_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

let db: PostgresJsDatabase;
let registry: EventHandlerRegistry;
let svc: EventReplayService;
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
  console.warn("PostgreSQL not available — skipping EventReplayService tests");
}

interface InsertOpts {
  tenantId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  sourceAction?: string;
  sourceExecutionId?: string;
  status?: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  errorMessage?: string;
  retryCount?: number;
  meta?: Record<string, unknown>;
}

async function insertEvent(opts?: InsertOpts): Promise<string> {
  const [row] = await db
    .insert(eventsTable)
    .values({
      eventType: opts?.eventType ?? "test.event",
      tenantId: opts?.tenantId,
      payload: opts?.payload ?? { test: true },
      sourceAction: opts?.sourceAction ?? null,
      sourceExecutionId: opts?.sourceExecutionId ?? null,
      status: opts?.status ?? "completed",
      errorMessage: opts?.errorMessage,
      retryCount: opts?.retryCount ?? 0,
      meta: opts?.meta,
    })
    .returning({ id: eventsTable.id });
  return row.id;
}

describe.skipIf(!dbAvailable)("EventReplayService", () => {
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
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await db.delete(eventsTable);
    registry = new EventHandlerRegistry();
    svc = createEventReplayService({ db, registry });
  });

  // ── list ───────────────────────────────────────────

  test("list returns empty result when table is empty", async () => {
    const result = await svc.list();
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("list returns events in descending creation order", async () => {
    const idFirst = await insertEvent({ eventType: "order.created" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const idSecond = await insertEvent({ eventType: "payment.captured" });

    const result = await svc.list();
    expect(result.total).toBe(2);
    expect(result.items[0].id).toBe(idSecond);
    expect(result.items[1].id).toBe(idFirst);
  });

  test("list filters by tenantId, eventType, entity, and time range", async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    await insertEvent({ tenantId: "t-a", eventType: "order.created", sourceAction: "create" });
    await insertEvent({ tenantId: "t-b", eventType: "order.created", sourceAction: "create" });
    await insertEvent({ tenantId: "t-a", eventType: "payment.failed", sourceAction: "pay" });

    const tenantA = await svc.list({ tenantId: "t-a" });
    expect(tenantA.total).toBe(2);

    const byType = await svc.list({ eventType: "order.created" });
    expect(byType.total).toBe(2);

    const byEntity = await svc.list({ entity: "pay" });
    expect(byEntity.total).toBe(1);

    const byRange = await svc.list({ since: earlier, until: new Date(now.getTime() + 60_000) });
    expect(byRange.total).toBe(3);
  });

  test("list filters by recordId at the SQL level and projects it into the summary", async () => {
    // Insert two matching rows beyond the first page and a few non-matching
    // ones; without server-side filtering, `--record X --limit 2` would miss
    // rows past offset 2 (the previous CLI N+1 bug — Gemini finding 1).
    await insertEvent({ eventType: "noise.a", payload: { recordId: "other" } });
    await insertEvent({ eventType: "noise.b", payload: { recordId: "other" } });
    await insertEvent({ eventType: "noise.c", payload: { recordId: "other" } });
    const matchA = await insertEvent({ eventType: "match.a", payload: { recordId: "target" } });
    await insertEvent({ eventType: "noise.d", payload: { recordId: "other" } });
    const matchB = await insertEvent({ eventType: "match.b", payload: { recordId: "target" } });

    const filtered = await svc.list({ recordId: "target", limit: 2 });
    expect(filtered.total).toBe(2);
    expect(filtered.items).toHaveLength(2);
    const ids = filtered.items.map((i) => i.id).sort();
    expect(ids).toEqual([matchA, matchB].sort());
    // EventSummary must surface the projected recordId so the CLI table can
    // render it without an extra round-trip per row.
    for (const item of filtered.items) {
      expect(item.recordId).toBe("target");
    }
  });

  test("list returns undefined recordId when payload omits the field", async () => {
    await insertEvent({ eventType: "no.record", payload: { other: "value" } });
    const result = await svc.list();
    expect(result.items[0].recordId).toBeUndefined();
  });

  test("list pagination clamps limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await insertEvent({ eventType: `evt.${i}` });
    }

    const page1 = await svc.list({ limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await svc.list({ limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(2);

    // Out-of-range pagination input is clamped, not rejected.
    const clamped = await svc.list({ limit: 9999, offset: -10 });
    expect(clamped.items.length).toBeLessThanOrEqual(100);
  });

  // ── get ────────────────────────────────────────────

  test("get returns full detail with payload, meta, and history", async () => {
    const id = await insertEvent({
      eventType: "order.created",
      payload: { orderId: "ord-1", total: 100 },
      meta: { _tenant_scope: "t-a" },
      status: "failed",
      errorMessage: "boom",
      retryCount: 2,
    });

    const detail = await svc.get(id);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(id);
    expect(detail?.payload).toEqual({ orderId: "ord-1", total: 100 });
    expect(detail?.meta).toEqual({ _tenant_scope: "t-a" });
    expect(detail?.status).toBe("failed");
    expect(detail?.errorMessage).toBe("boom");
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0].handler).toBe("*");
    expect(detail?.history[0].status).toBe("failed");
    expect(detail?.history[0].retryCount).toBe(2);
  });

  test("get returns null for missing id", async () => {
    const detail = await svc.get("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });

  test("get returns null for non-UUID id", async () => {
    const detail = await svc.get("not-a-uuid");
    expect(detail).toBeNull();
  });

  // ── replay ─────────────────────────────────────────

  test("replay re-dispatches event to all matching handlers", async () => {
    const seen: Array<{ name: string; payload: unknown }> = [];
    registry.register({
      name: "h1",
      listen: "user.created",
      handler: async (e) => {
        seen.push({ name: "h1", payload: e.payload });
      },
    });
    registry.register({
      name: "h2",
      listen: "user.created",
      handler: async (e) => {
        seen.push({ name: "h2", payload: e.payload });
      },
    });

    const id = await insertEvent({
      eventType: "user.created",
      payload: { userId: "u-1" },
    });

    const result = await svc.replay(id);
    expect(result.delivered).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(seen.map((s) => s.name).sort()).toEqual(["h1", "h2"]);
    expect(seen[0].payload).toEqual({ userId: "u-1" });

    // Original event row is NOT mutated.
    const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
    expect(row.status).toBe("completed");
  });

  test("replay collects handler errors instead of throwing", async () => {
    registry.register({
      name: "ok-handler",
      listen: "order.failed",
      handler: async () => {
        // success
      },
    });
    registry.register({
      name: "bad-handler",
      listen: "order.failed",
      handler: async () => {
        throw new Error("downstream timeout");
      },
    });

    const id = await insertEvent({ eventType: "order.failed" });
    const result = await svc.replay(id);

    expect(result.delivered).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ handler: "bad-handler", message: "downstream timeout" });
  });

  test("replay onlyHandler restricts dispatch to a single handler", async () => {
    const fired: string[] = [];
    registry.register({
      name: "h1",
      listen: "wide.event",
      handler: async () => {
        fired.push("h1");
      },
    });
    registry.register({
      name: "h2",
      listen: "wide.event",
      handler: async () => {
        fired.push("h2");
      },
    });

    const id = await insertEvent({ eventType: "wide.event" });
    const result = await svc.replay(id, { onlyHandler: "h2" });

    expect(result.delivered).toBe(1);
    expect(fired).toEqual(["h2"]);
  });

  test("replay returns zero delivered when event is missing", async () => {
    const result = await svc.replay("00000000-0000-0000-0000-000000000000");
    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("replay returns zero delivered when no handlers are registered", async () => {
    const id = await insertEvent({ eventType: "no.listeners" });
    const result = await svc.replay(id);
    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ── replayBatch ────────────────────────────────────

  test("replayBatch processes multiple ids and aggregates totals", async () => {
    const fired: string[] = [];
    registry.register({
      name: "batch-handler",
      listen: "batch.event",
      handler: async (e) => {
        fired.push(String(e.payload.k));
      },
    });

    const id1 = await insertEvent({ eventType: "batch.event", payload: { k: "a" } });
    const id2 = await insertEvent({ eventType: "batch.event", payload: { k: "b" } });
    const id3 = await insertEvent({ eventType: "batch.event", payload: { k: "c" } });
    const missing = "00000000-0000-0000-0000-000000000000";

    const result = await svc.replayBatch([id1, id2, missing, id3]);

    expect(result.results).toHaveLength(4);
    expect(result.totalDelivered).toBe(3);
    expect(result.totalErrors).toBe(0);
    expect(result.results[2].replayed).toBe(false);
    expect(fired.sort()).toEqual(["a", "b", "c"]);
  });

  test("replayBatch empty input returns zeroed result", async () => {
    const result = await svc.replayBatch([]);
    expect(result.results).toEqual([]);
    expect(result.totalDelivered).toBe(0);
    expect(result.totalErrors).toBe(0);
  });

  test("replayBatch rejects oversized batches", async () => {
    const ids = Array.from({ length: 101 }, () => "00000000-0000-0000-0000-000000000000");
    await expect(svc.replayBatch(ids)).rejects.toThrow(/exceeds maximum/);
  });

  // ── handlerHistory ─────────────────────────────────

  test("handlerHistory returns the per-event delivery summary", async () => {
    const id = await insertEvent({
      eventType: "audit.applied",
      status: "completed",
      retryCount: 1,
    });

    const history = await svc.handlerHistory({ eventId: id });
    expect(history).toHaveLength(1);
    expect(history[0].eventId).toBe(id);
    expect(history[0].handler).toBe("*");
    expect(history[0].status).toBe("completed");
    expect(history[0].retryCount).toBe(1);
  });

  test("handlerHistory filtered by handler name still returns the wildcard summary", async () => {
    const id = await insertEvent({ eventType: "filterable.event" });
    const history = await svc.handlerHistory({ eventId: id, handler: "any-name" });
    expect(history).toHaveLength(1);
    expect(history[0].handler).toBe("*");
  });

  test("handlerHistory returns empty array for missing or invalid id", async () => {
    expect(await svc.handlerHistory({ eventId: "not-uuid" })).toEqual([]);
    expect(await svc.handlerHistory({ eventId: "00000000-0000-0000-0000-000000000000" })).toEqual(
      [],
    );
  });
});
