/**
 * AITraceSink conformance — in-memory run + non-throwing discipline.
 *
 * Always-on (no database required):
 *  1. Runs the shared conformance suite against `InMemoryAITraceStore`, so CI
 *     without PostgreSQL still exercises every contract assertion (the same
 *     assertions run against the PG store in
 *     `ai-trace-store-drizzle.integration.test.ts`).
 *  2. Proves `DrizzleAITraceStore`'s non-throwing discipline with a database
 *     stub that always fails: sink methods on the AI call path must swallow +
 *     log mirror failures, keep the serialized write tail alive, and keep
 *     serving the in-memory hot view.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "@linchkit/core";
import { InMemoryAITraceStore } from "@linchkit/core/server";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DrizzleAITraceStore } from "../src/ai-trace-store-drizzle";
import {
  type AITraceSinkHarness,
  registerAITraceSinkConformance,
} from "./helpers/ai-trace-sink-conformance";

// ── 1. Conformance against the in-memory reference ──────────

describe("InMemoryAITraceStore (sink conformance)", () => {
  const sink = new InMemoryAITraceStore();
  const harness: AITraceSinkHarness = {
    sink,
    flush: async () => {},
    queryGenerations: async (options) => sink.query(options),
    queryTraces: async (options) => sink.queryTraces(options),
    reset: async () => {
      sink.clear();
    },
  };
  registerAITraceSinkConformance(() => harness);
});

// ── 2. Non-throwing discipline with a broken database ───────

function createCapturingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
  };
}

/** A "database" whose every entry point throws synchronously. */
function createThrowingDb(): PostgresJsDatabase {
  const boom = () => {
    throw new Error("pg unreachable");
  };
  return {
    insert: boom,
    update: boom,
    delete: boom,
    select: boom,
    execute: boom,
  } as unknown as PostgresJsDatabase;
}

describe("DrizzleAITraceStore (non-throwing discipline, no DB needed)", () => {
  let logger: ReturnType<typeof createCapturingLogger>;
  let store: DrizzleAITraceStore;

  beforeEach(() => {
    logger = createCapturingLogger();
    store = new DrizzleAITraceStore({ db: createThrowingDb(), logger });
  });

  it("never throws into the AI call path when every mirror write fails", async () => {
    // None of the synchronous sink methods may throw.
    const traceId = store.startTrace({ name: "intent", tenantId: "t1" });
    const generation = store.recordGeneration({
      traceId,
      model: "m1",
      provider: "p1",
      messages: [{ role: "user", content: "top secret prompt" }],
      completion: "top secret completion",
      inputTokens: 5,
      outputTokens: 6,
      latencyMs: 10,
      status: "ok",
      startedAt: 1_000,
      endedAt: 1_010,
      redaction: { mode: "mask" },
    });
    store.endTrace({ traceId });
    store.clear();

    // recordGeneration still returned the (redacted) record synchronously.
    expect(generation.traceId).toBe(traceId);
    expect(generation.completion).not.toContain("secret");
    expect(generation.messages[0]?.content).not.toContain("secret");

    // The write tail settles (never rejects) and each failed stage logged once.
    await store.whenPersisted();
    expect(logger.warnings.length).toBe(4); // startTrace, recordGeneration, endTrace, clear
    expect(logger.warnings[0]).toContain("[ai-trace-store] startTrace");
    expect(logger.warnings[0]).toContain("pg unreachable");
  });

  it("keeps the write tail alive across failures and keeps serving the hot view", async () => {
    const traceId = store.startTrace({ name: "intent", tenantId: "t1" });
    await store.whenPersisted(); // first mirror write already failed
    expect(logger.warnings.length).toBe(1);

    // A later write is still attempted (tail not stuck on the earlier failure)
    // and the synchronous hot view serves reads regardless of PG health.
    store.recordGeneration({
      traceId,
      model: "m1",
      provider: "p1",
      messages: [{ role: "user", content: "hi" }],
      completion: "ok",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 5,
      status: "ok",
      startedAt: 2_000,
      endedAt: 2_005,
      redaction: { mode: "none" },
    });
    await store.whenPersisted();
    expect(logger.warnings.length).toBe(2);
    expect(store.size).toBe(1);
    expect(store.query({ tenantId: "t1" })).toHaveLength(1);
    expect(store.queryTraces({ traceId })).toHaveLength(1);
  });

  it("purgeOlderThan validates days before touching the database", async () => {
    await expect(store.purgeOlderThan(0)).rejects.toThrow(RangeError);
    await expect(store.purgeOlderThan(-5)).rejects.toThrow(RangeError);
    await expect(store.purgeOlderThan(Number.NaN)).rejects.toThrow(RangeError);
  });
});
