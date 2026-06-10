/**
 * DrizzleAITraceStore integration tests against a real PostgreSQL database.
 *
 * The always-on suite in `ai-trace-store-conformance.test.ts` proves the
 * contract against the in-memory reference + the non-throwing discipline.
 * This suite drives the REAL Drizzle-backed store against real
 * `_linchkit.ai_traces` / `_linchkit.ai_generations` tables to prove:
 *   - the shared conformance suite holds when reads go through the SQL
 *     translation (`queryPersisted` / `queryTracesPersisted`),
 *   - mirror writes survive a process "restart" (a fresh store instance on
 *     the same DB sees everything; its hot view starts empty),
 *   - aggregate rollups are durable SQL increments (a restarted instance
 *     keeps incrementing the same trace row),
 *   - `purgeOlderThan` retention deletes old generations + orphaned traces.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 * Skips gracefully when no database is available (CI without PG won't fail);
 * CI provides the `postgres` service so this suite RUNS there.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeDatabase, createDatabase } from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DrizzleAITraceStore } from "../src/ai-trace-store-drizzle";
import {
  type AITraceSinkHarness,
  registerAITraceSinkConformance,
} from "./helpers/ai-trace-sink-conformance";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const TRACES = `"_linchkit"."ai_traces"`;
const GENERATIONS = `"_linchkit"."ai_generations"`;

// ── Connection check ─────────────────────────────────────────

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  } finally {
    // Always release the probe pool so a failed probe never leaks connections.
    await closeDatabase();
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping DrizzleAITraceStore integration tests");
}

// ── Fixtures ─────────────────────────────────────────────────

let db: PostgresJsDatabase | null = null;
let store: DrizzleAITraceStore;

/**
 * Narrow `db` to non-null. Assigned in beforeAll; the suite is skipped when no
 * DB is available, so this never throws in practice. A clear error beats the
 * repo-banned `db!` non-null assertion (biome `noNonNullAssertion`).
 */
function requireDb(): PostgresJsDatabase {
  if (!db) throw new Error("db not initialized — beforeAll did not run");
  return db;
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("DrizzleAITraceStore (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // The `_linchkit` schema already hosts framework system tables, but create
    // it defensively so the suite is self-contained.
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "_linchkit"`));

    // Drop any leftover tables, then recreate them as a test fixture. This is
    // NOT production DDL (production DDL is delegated to drizzle-kit); it
    // mirrors the column shape + indexes declared in src/ai-trace-tables.ts so
    // the real DrizzleAITraceStore runs against an authentic schema.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${GENERATIONS} CASCADE`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TRACES} CASCADE`));
    await db.execute(
      sql.raw(`
      CREATE TABLE ${TRACES} (
        "trace_id" text PRIMARY KEY NOT NULL,
        "seq" bigserial NOT NULL,
        "name" text NOT NULL,
        "tenant_id" text,
        "actor_id" text,
        "scenario" text,
        "fixture_id" text,
        "eval_run_id" text,
        "origin" text NOT NULL,
        "tags" jsonb,
        "metadata" jsonb,
        "started_at" timestamp NOT NULL,
        "ended_at" timestamp,
        "input_tokens" integer DEFAULT 0 NOT NULL,
        "output_tokens" integer DEFAULT 0 NOT NULL,
        "cost" double precision DEFAULT 0 NOT NULL,
        "sampled" boolean DEFAULT true NOT NULL,
        "status" text DEFAULT 'ok' NOT NULL
      )
    `),
    );
    await db.execute(
      sql.raw(
        `CREATE INDEX "idx_ai_traces_tenant_started" ON ${TRACES} ("tenant_id","started_at")`,
      ),
    );
    await db.execute(
      sql.raw(`
      CREATE TABLE ${GENERATIONS} (
        "id" text PRIMARY KEY NOT NULL,
        "seq" bigserial NOT NULL,
        "trace_id" text NOT NULL,
        "model" text NOT NULL,
        "provider" text NOT NULL,
        "messages" jsonb NOT NULL,
        "completion" text NOT NULL,
        "input_tokens" integer NOT NULL,
        "output_tokens" integer NOT NULL,
        "cost" double precision,
        "latency_ms" double precision NOT NULL,
        "temperature" double precision,
        "response_format" text,
        "fallback_used" text,
        "cached" boolean,
        "partial" boolean,
        "status" text NOT NULL,
        "error" text,
        "started_at" timestamp NOT NULL,
        "ended_at" timestamp NOT NULL
      )
    `),
    );
    await db.execute(
      sql.raw(`CREATE INDEX "idx_ai_generations_trace_id" ON ${GENERATIONS} ("trace_id")`),
    );
    await db.execute(
      sql.raw(`CREATE INDEX "idx_ai_generations_started_at" ON ${GENERATIONS} ("started_at")`),
    );

    store = new DrizzleAITraceStore({ db });
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${GENERATIONS} CASCADE`));
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TRACES} CASCADE`));
      await closeDatabase();
    }
  });

  // ── 1. Shared conformance suite, read through SQL ──────────

  describe("sink conformance via queryPersisted", () => {
    const harness: AITraceSinkHarness = {
      get sink() {
        return store;
      },
      flush: () => store.whenPersisted(),
      queryGenerations: (options) => store.queryPersisted(options),
      queryTraces: (options) => store.queryTracesPersisted(options),
      reset: async () => {
        // clear() wipes the hot view and enqueues the mirror wipe; drain it.
        store.clear();
        await store.whenPersisted();
      },
    };
    registerAITraceSinkConformance(() => harness);
  });

  // ── 2. Restart durability ──────────────────────────────────

  describe("durability across instances", () => {
    it("a fresh store on the same DB sees persisted data; its hot view starts empty", async () => {
      store.clear();
      await store.whenPersisted();

      const traceId = store.startTrace({ name: "intent", tenantId: "t1", startedAt: 1_000 });
      store.recordGeneration({
        traceId,
        model: "m1",
        provider: "p1",
        messages: [{ role: "user", content: "hello" }],
        completion: "done",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.01,
        latencyMs: 100,
        status: "ok",
        startedAt: 1_100,
        endedAt: 1_200,
        redaction: { mode: "none" },
      });
      await store.whenPersisted();

      // Simulated restart: new store instance, same database.
      const restarted = new DrizzleAITraceStore({ db: requireDb() });
      expect(restarted.size).toBe(0);
      expect(restarted.query()).toEqual([]); // hot view is process-local
      const persisted = await restarted.queryPersisted({ tenantId: "t1" });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.completion).toBe("done");
      const traces = await restarted.queryTracesPersisted({ traceId });
      expect(traces[0]?.inputTokens).toBe(10);

      // Durable SQL increments: the restarted instance keeps rolling up the
      // SAME trace row even though its hot view auto-opens a fresh copy.
      restarted.recordGeneration({
        traceId,
        model: "m1",
        provider: "p1",
        messages: [{ role: "user", content: "again" }],
        completion: "done again",
        inputTokens: 7,
        outputTokens: 3,
        cost: 0.02,
        latencyMs: 80,
        status: "error",
        error: "boom",
        startedAt: 1_300,
        endedAt: 1_400,
        redaction: { mode: "none" },
      });
      await restarted.whenPersisted();

      const [rolled] = await restarted.queryTracesPersisted({ traceId });
      expect(rolled?.inputTokens).toBe(17);
      expect(rolled?.outputTokens).toBe(8);
      expect(rolled?.cost ?? 0).toBeCloseTo(0.03, 10);
      expect(rolled?.status).toBe("error");
      // The original trace metadata survives (auto-open insert was a no-op).
      expect(rolled?.name).toBe("intent");
      expect(rolled?.tenantId).toBe("t1");
      expect(await restarted.queryPersisted({ traceId })).toHaveLength(2);
    });
  });

  // ── 3. Retention ───────────────────────────────────────────

  describe("purgeOlderThan", () => {
    it("deletes old generations and orphaned old traces, keeps referenced ones", async () => {
      store.clear();
      await store.whenPersisted();

      const now = Date.now();
      const oldTime = now - 100 * 86_400_000; // 100 days ago
      const recentTime = now - 1 * 86_400_000; // yesterday

      const mkGen = (traceId: string, startedAt: number) => ({
        traceId,
        model: "m1",
        provider: "p1",
        messages: [{ role: "user" as const, content: "x" }],
        completion: "y",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 10,
        status: "ok" as const,
        startedAt,
        endedAt: startedAt + 10,
        redaction: { mode: "none" } as const,
      });

      // Old trace whose only generation is old → both purged.
      store.startTrace({ traceId: "trace-old", name: "old", startedAt: oldTime });
      store.recordGeneration(mkGen("trace-old", oldTime + 1_000));
      // Old trace that ALSO has a recent generation → old gen purged, trace kept.
      store.startTrace({ traceId: "trace-mixed", name: "mixed", startedAt: oldTime });
      store.recordGeneration(mkGen("trace-mixed", oldTime + 2_000));
      store.recordGeneration(mkGen("trace-mixed", recentTime));
      // Fully recent trace → untouched.
      store.startTrace({ traceId: "trace-new", name: "new", startedAt: recentTime });
      store.recordGeneration(mkGen("trace-new", recentTime + 1_000));
      await store.whenPersisted();

      const purged = await store.purgeOlderThan(90);
      expect(purged).toEqual({ generations: 2, traces: 1 });

      const traceIds = (await store.queryTracesPersisted()).map((t) => t.traceId);
      expect(traceIds.sort()).toEqual(["trace-mixed", "trace-new"]);
      const gens = await store.queryPersisted();
      expect(gens).toHaveLength(2);
      expect(gens.every((g) => g.startedAt >= recentTime)).toBe(true);

      // Default window (90 days) keeps everything that's left.
      const second = await store.purgeOlderThan();
      expect(second).toEqual({ generations: 0, traces: 0 });
    });
  });
});
