/**
 * DrizzleExecutionLogger meta-persistence tests.
 *
 * Spec 65 §9 — meta is recorded on every execution log entry. The Drizzle
 * adapter must persist meta to a dedicated jsonb column (not lump it into the
 * existing `metadata` blob) so production queries / admin UIs can index and
 * filter on `_channel`, `_depth`, caller-supplied `source_view`, etc.
 *
 * The full integration suite (real PostgreSQL) lives in
 * `drizzle-data-provider.integration.test.ts` and skips when no DB is
 * available. These tests use a stub PostgresJsDatabase that captures the
 * `.values(...)` payload and replays it back through the same Drizzle table
 * column shape to verify both the write path and the rowToEntry hydration.
 */
import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DrizzleExecutionLogger } from "../src/persistence/drizzle-execution-logger";
import type { executionsTable } from "../src/persistence/system-tables";
import type { ExecutionLogEntry } from "../src/types/execution-log";

// Captures every `.values(...)` call so we can inspect what Drizzle would
// have written to the row. We don't run a real INSERT; we hand the captured
// row right back to `getById` so rowToEntry exercises the same parsing it
// would on a Postgres-returned row.
function createStubDb(): {
  db: PostgresJsDatabase;
  inserted: Array<Record<string, unknown>>;
} {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: (_table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        inserted.push(vals);
      },
    }),
    select: () => ({
      from: (_t: unknown) => ({
        where: (_c: unknown) => ({
          limit: async (_n: number) => {
            // Replay captured values as a row — Drizzle's $inferSelect uses
            // the same JS column names the executionsTable was declared with.
            return inserted.map((v) => normalizeForRowToEntry(v));
          },
        }),
        orderBy: (_o: unknown) => ({
          limit: async (_n: number) => inserted.map((v) => normalizeForRowToEntry(v)),
        }),
      }),
    }),
  } as unknown as PostgresJsDatabase;
  return { db, inserted };
}

/**
 * Map the values payload back to the shape Drizzle returns from a SELECT.
 * Drizzle's `$inferSelect` uses the JS field names from `pgTable(...)`, which
 * match the column keys passed to `.values(...)` for this table. Defaults
 * (started_at, completed_at) are already concrete in the entry, so this is
 * largely a passthrough; the only adjustment is hydrating columns the row
 * shape declares but the test entry omits.
 */
function normalizeForRowToEntry(v: Record<string, unknown>): typeof executionsTable.$inferSelect {
  return {
    id: v.id,
    tenantId: v.tenantId ?? null,
    actionName: v.actionName,
    entityName: v.entityName ?? null,
    recordId: v.recordId ?? null,
    capability: v.capability ?? null,
    input: v.input ?? null,
    output: v.output ?? null,
    actorId: v.actorId ?? null,
    actorType: v.actorType ?? null,
    status: v.status,
    errorCode: v.errorCode ?? null,
    errorMessage: v.errorMessage ?? null,
    durationMs: v.durationMs ?? null,
    channel: v.channel ?? null,
    parentExecutionId: v.parentExecutionId ?? null,
    idempotencyKey: v.idempotencyKey ?? null,
    metadata: v.metadata ?? null,
    meta: v.meta ?? null,
    startedAt: v.startedAt ?? new Date(),
    completedAt: v.completedAt ?? null,
    createdAt: v.startedAt ?? new Date(),
  } as typeof executionsTable.$inferSelect;
}

const baseEntry: ExecutionLogEntry = {
  id: "exec_drizzle_meta_1",
  action: "create_order",
  entity: "order",
  actor: { type: "human", id: "u1", groups: [] },
  input: { title: "Test" },
  status: "succeeded",
  duration: 12,
  startedAt: new Date("2025-01-01T00:00:00Z"),
  completedAt: new Date("2025-01-01T00:00:00.012Z"),
};

describe("DrizzleExecutionLogger — meta jsonb column (Spec 65 §9)", () => {
  test("persists caller-supplied meta into the dedicated meta column", async () => {
    const { db, inserted } = createStubDb();
    const logger = new DrizzleExecutionLogger(db);

    await logger.log({
      ...baseEntry,
      meta: {
        source_view: "queue",
        bulk: true,
        _channel: "http",
        _depth: 0,
        _execution_id: "exec_drizzle_meta_1",
      },
    });

    expect(inserted).toHaveLength(1);
    const written = inserted[0] as Record<string, unknown>;
    expect(written.meta).toEqual({
      source_view: "queue",
      bulk: true,
      _channel: "http",
      _depth: 0,
      _execution_id: "exec_drizzle_meta_1",
    });
    // metadata column is for non-meta JSON (actor, rules, etc.) — meta must
    // not piggy-back on it.
    expect(written.metadata).not.toMatchObject({ source_view: "queue" });
  });

  test("writes null when meta is omitted", async () => {
    const { db, inserted } = createStubDb();
    const logger = new DrizzleExecutionLogger(db);

    await logger.log({ ...baseEntry, id: "exec_no_meta" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.meta).toBeNull();
  });

  test("rowToEntry hydrates meta on read (round-trip)", async () => {
    const { db } = createStubDb();
    const logger = new DrizzleExecutionLogger(db);

    const recordedMeta = {
      source_view: "graphql_explorer",
      _channel: "http",
      _depth: 0,
      _execution_id: "exec_roundtrip",
    };
    await logger.log({ ...baseEntry, id: "exec_roundtrip", meta: recordedMeta });

    const retrieved = await logger.getById("exec_roundtrip");
    expect(retrieved).toBeDefined();
    expect(retrieved?.meta).toEqual(recordedMeta);
    // Other passthrough fields still hydrate correctly.
    expect(retrieved?.action).toBe("create_order");
    expect(retrieved?.entity).toBe("order");
  });

  test("rowToEntry returns undefined meta when column is null", async () => {
    const { db } = createStubDb();
    const logger = new DrizzleExecutionLogger(db);

    await logger.log({ ...baseEntry, id: "exec_meta_null" });

    const retrieved = await logger.getById("exec_meta_null");
    expect(retrieved).toBeDefined();
    expect(retrieved?.meta).toBeUndefined();
  });
});
