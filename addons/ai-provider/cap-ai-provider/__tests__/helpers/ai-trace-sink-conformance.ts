/**
 * Shared AITraceSink conformance suite (Spec 69 Phase 3, issue #350).
 *
 * One set of assertions, run against BOTH sink implementations so the
 * Drizzle/PG store provably matches `InMemoryAITraceStore`'s query semantics:
 *  - `ai-trace-store-conformance.test.ts` runs it against the in-memory store
 *    (always-on — CI without PostgreSQL still exercises the full contract);
 *  - `ai-trace-store-drizzle.integration.test.ts` runs it against the real
 *    PG-backed store (DB-gated), reading through `queryPersisted` /
 *    `queryTracesPersisted` so the SQL filter translation is what's tested.
 *
 * NOT a test file itself (no `.test.ts` suffix) — it only registers `it`
 * blocks into the caller's `describe`.
 */

import { beforeEach, expect, it } from "bun:test";
import type {
  AIGeneration,
  AITrace,
  AITraceQueryOptions,
  AITraceSink,
  RecordGenerationParams,
} from "@linchkit/core/server";
import { redactContent } from "@linchkit/core/server";

/** Implementation-agnostic view of a sink under conformance test. */
export interface AITraceSinkHarness {
  sink: AITraceSink;
  /** Drain any async mirror so reads observe all prior writes. */
  flush(): Promise<void>;
  /** The implementation's authoritative generation query. */
  queryGenerations(options?: AITraceQueryOptions): Promise<AIGeneration[]>;
  /** The implementation's authoritative trace query. */
  queryTraces(options?: AITraceQueryOptions): Promise<AITrace[]>;
  /** Remove all stored data (runs before every case). */
  reset(): Promise<void>;
}

/** Fixed time base so strict `after`/`before` bounds are deterministic. */
export const CONFORMANCE_BASE_MS = Date.UTC(2026, 0, 1);

const NO_REDACTION = { mode: "none" } as const;

function gen(overrides: Partial<RecordGenerationParams>): RecordGenerationParams {
  return {
    traceId: "trace-a",
    model: "m1",
    provider: "p1",
    messages: [{ role: "user", content: "hello world" }],
    completion: "a completion",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 50,
    status: "ok",
    startedAt: CONFORMANCE_BASE_MS,
    endedAt: CONFORMANCE_BASE_MS + 10,
    redaction: NO_REDACTION,
    ...overrides,
  };
}

/**
 * Seed the standard dataset: two explicit traces (a: tenant t1 / eval /
 * scenario intent; b: tenant t2 / production) plus an auto-opened trace c
 * (recordGeneration without startTrace, tenant t3). Generation insertion
 * order: g1(a), g2(a, error), g3(b), g4(c) — so most-recent-first is
 * [g4, g3, g2, g1].
 */
async function seed(h: AITraceSinkHarness): Promise<void> {
  const B = CONFORMANCE_BASE_MS;
  h.sink.startTrace({
    traceId: "trace-a",
    name: "intent",
    tenantId: "t1",
    actorId: "actor-1",
    scenario: "intent",
    fixtureId: "fx-1",
    evalRunId: "run-1",
    origin: "eval",
    tags: ["nightly", "smoke"],
    metadata: { suite: "conformance" },
    startedAt: B + 1_000,
  });
  h.sink.startTrace({
    traceId: "trace-b",
    name: "chat",
    tenantId: "t2",
    origin: "production",
    startedAt: B + 2_000,
  });
  h.sink.recordGeneration(
    gen({
      traceId: "trace-a",
      model: "m1",
      provider: "p1",
      completion: "first completion",
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
      latencyMs: 100.5,
      temperature: 0.2,
      responseFormat: "json",
      startedAt: B + 1_100,
      endedAt: B + 1_200,
    }),
  );
  h.sink.recordGeneration(
    gen({
      traceId: "trace-a",
      model: "m2",
      provider: "p1",
      completion: "second completion",
      inputTokens: 20,
      outputTokens: 7,
      cost: 0.02,
      latencyMs: 150,
      status: "error",
      error: "boom (already redacted)",
      fallbackUsed: "p0",
      startedAt: B + 1_300,
      endedAt: B + 1_400,
    }),
  );
  h.sink.recordGeneration(
    gen({
      traceId: "trace-b",
      model: "m1",
      provider: "p2",
      completion: "third completion",
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 50,
      cached: true,
      startedAt: B + 2_100,
      endedAt: B + 2_200,
    }),
  );
  h.sink.recordGeneration(
    gen({
      traceId: "trace-c",
      model: "m3",
      provider: "p3",
      completion: "fourth completion",
      inputTokens: 3,
      outputTokens: 4,
      latencyMs: 60,
      partial: true,
      tenantId: "t3",
      startedAt: B + 3_100,
      endedAt: B + 3_200,
    }),
  );
  await h.flush();
}

/** Register the conformance cases inside the caller's `describe` block. */
export function registerAITraceSinkConformance(getHarness: () => AITraceSinkHarness): void {
  const B = CONFORMANCE_BASE_MS;

  beforeEach(async () => {
    await getHarness().reset();
  });

  it("returns generations most-recent-first with full field round-trip", async () => {
    const h = getHarness();
    await seed(h);
    const all = await h.queryGenerations();
    expect(all.map((g) => g.completion)).toEqual([
      "fourth completion",
      "third completion",
      "second completion",
      "first completion",
    ]);

    const first = all[3];
    expect(first?.traceId).toBe("trace-a");
    expect(first?.model).toBe("m1");
    expect(first?.provider).toBe("p1");
    expect(first?.messages).toEqual([{ role: "user", content: "hello world" }]);
    expect(first?.inputTokens).toBe(10);
    expect(first?.outputTokens).toBe(5);
    expect(first?.cost).toBe(0.01);
    expect(first?.latencyMs).toBe(100.5);
    expect(first?.temperature).toBe(0.2);
    expect(first?.responseFormat).toBe("json");
    expect(first?.status).toBe("ok");
    expect(first?.startedAt).toBe(B + 1_100);
    expect(first?.endedAt).toBe(B + 1_200);
    expect(first?.error).toBeUndefined();
    expect(first?.cached).toBeUndefined();
    expect(first?.partial).toBeUndefined();
    expect(first?.fallbackUsed).toBeUndefined();

    const errored = all[2];
    expect(errored?.status).toBe("error");
    expect(errored?.error).toBe("boom (already redacted)");
    expect(errored?.fallbackUsed).toBe("p0");

    expect(all[0]?.partial).toBe(true);
    expect(all[1]?.cached).toBe(true);
  });

  it("applies limit semantics: 0 ⇒ empty, positive caps, negative ⇒ uncapped", async () => {
    const h = getHarness();
    await seed(h);
    expect(await h.queryGenerations({ limit: 0 })).toEqual([]);
    expect((await h.queryGenerations({ limit: 2 })).map((g) => g.completion)).toEqual([
      "fourth completion",
      "third completion",
    ]);
    expect(await h.queryGenerations({ limit: -1 })).toHaveLength(4);
    expect(await h.queryTraces({ limit: 0 })).toEqual([]);
    expect((await h.queryTraces({ limit: 2 })).map((t) => t.traceId)).toEqual([
      "trace-c",
      "trace-b",
    ]);
    expect(await h.queryTraces({ limit: -1 })).toHaveLength(3);
  });

  it("filters generations by traceId / model / status", async () => {
    const h = getHarness();
    await seed(h);
    expect((await h.queryGenerations({ traceId: "trace-a" })).map((g) => g.model)).toEqual([
      "m2",
      "m1",
    ]);
    expect((await h.queryGenerations({ model: "m1" })).map((g) => g.completion)).toEqual([
      "third completion",
      "first completion",
    ]);
    const errored = await h.queryGenerations({ status: "error" });
    expect(errored).toHaveLength(1);
    expect(errored[0]?.model).toBe("m2");
  });

  it("applies STRICT after/before bounds on startedAt", async () => {
    const h = getHarness();
    await seed(h);
    // `after` is exclusive: a generation starting exactly at the bound is out.
    expect(await h.queryGenerations({ after: B + 1_100 })).toHaveLength(3);
    expect(await h.queryGenerations({ after: B + 1_099 })).toHaveLength(4);
    // `before` is exclusive too.
    expect(await h.queryGenerations({ before: B + 3_100 })).toHaveLength(3);
    expect(await h.queryGenerations({ before: B + 3_101 })).toHaveLength(4);
    expect(
      (await h.queryGenerations({ after: B + 1_100, before: B + 2_100 })).map((g) => g.model),
    ).toEqual(["m2"]);
  });

  it("resolves tenant / scenario / origin filters via the parent trace", async () => {
    const h = getHarness();
    await seed(h);
    expect((await h.queryGenerations({ tenantId: "t1" })).map((g) => g.model)).toEqual([
      "m2",
      "m1",
    ]);
    // Auto-opened trace c was stamped with the generation's tenantId.
    expect((await h.queryGenerations({ tenantId: "t3" })).map((g) => g.model)).toEqual(["m3"]);
    expect(await h.queryGenerations({ tenantId: "nobody" })).toEqual([]);
    expect((await h.queryGenerations({ scenario: "intent" })).map((g) => g.model)).toEqual([
      "m2",
      "m1",
    ]);
    // trace-b is production; auto-opened trace-c defaults to production.
    expect((await h.queryGenerations({ origin: "production" })).map((g) => g.model)).toEqual([
      "m3",
      "m1",
    ]);
    expect((await h.queryGenerations({ origin: "eval" })).map((g) => g.model)).toEqual([
      "m2",
      "m1",
    ]);
  });

  it("queries traces most-recent-first with filters and metadata round-trip", async () => {
    const h = getHarness();
    await seed(h);
    const all = await h.queryTraces();
    expect(all.map((t) => t.traceId)).toEqual(["trace-c", "trace-b", "trace-a"]);

    const a = all[2];
    expect(a?.name).toBe("intent");
    expect(a?.tenantId).toBe("t1");
    expect(a?.actorId).toBe("actor-1");
    expect(a?.scenario).toBe("intent");
    expect(a?.fixtureId).toBe("fx-1");
    expect(a?.evalRunId).toBe("run-1");
    expect(a?.origin).toBe("eval");
    expect(a?.tags).toEqual(["nightly", "smoke"]);
    expect(a?.metadata).toEqual({ suite: "conformance" });
    expect(a?.startedAt).toBe(B + 1_000);
    expect(a?.sampled).toBe(true);

    expect((await h.queryTraces({ tenantId: "t2" })).map((t) => t.traceId)).toEqual(["trace-b"]);
    expect((await h.queryTraces({ scenario: "intent" })).map((t) => t.traceId)).toEqual([
      "trace-a",
    ]);
    expect((await h.queryTraces({ origin: "production" })).map((t) => t.traceId)).toEqual([
      "trace-c",
      "trace-b",
    ]);
    expect((await h.queryTraces({ traceId: "trace-b" })).map((t) => t.traceId)).toEqual([
      "trace-b",
    ]);
    expect((await h.queryTraces({ after: B + 1_000, before: B + 3_100 })).map((t) => t.traceId))
      // strict bounds: trace-a (B+1000) excluded, trace-c (auto-open, ~now) excluded
      .toEqual(["trace-b"]);
  });

  it("rolls aggregate tokens / cost up to the parent trace and escalates status", async () => {
    const h = getHarness();
    await seed(h);
    const [a] = await h.queryTraces({ traceId: "trace-a" });
    expect(a?.inputTokens).toBe(30);
    expect(a?.outputTokens).toBe(12);
    expect(a?.cost ?? 0).toBeCloseTo(0.03, 10);
    // g2 was an error — trace status escalates and stays escalated.
    expect(a?.status).toBe("error");

    const [b] = await h.queryTraces({ traceId: "trace-b" });
    expect(b?.inputTokens).toBe(1);
    expect(b?.outputTokens).toBe(2);
    expect(b?.cost).toBe(0);
    expect(b?.status).toBe("ok");
    // Trace-level status filter sees the escalation.
    expect((await h.queryTraces({ status: "error" })).map((t) => t.traceId)).toEqual(["trace-a"]);
  });

  it("auto-opens a parent trace named after the model when none was started", async () => {
    const h = getHarness();
    await seed(h);
    const [c] = await h.queryTraces({ traceId: "trace-c" });
    expect(c?.name).toBe("m3");
    expect(c?.tenantId).toBe("t3");
    expect(c?.origin).toBe("production");
    expect(c?.sampled).toBe(true);
    expect(c?.inputTokens).toBe(3);
    expect(c?.outputTokens).toBe(4);
  });

  it("endTrace stamps endedAt + status; unknown traceId is a no-op", async () => {
    const h = getHarness();
    await seed(h);
    h.sink.endTrace({ traceId: "trace-a", status: "partial", endedAt: B + 9_000 });
    h.sink.endTrace({ traceId: "trace-b", endedAt: B + 9_500 }); // keep status
    h.sink.endTrace({ traceId: "trace-nope", status: "error" });
    await h.flush();

    const [a] = await h.queryTraces({ traceId: "trace-a" });
    expect(a?.endedAt).toBe(B + 9_000);
    expect(a?.status).toBe("partial");
    const [b] = await h.queryTraces({ traceId: "trace-b" });
    expect(b?.endedAt).toBe(B + 9_500);
    expect(b?.status).toBe("ok");
    expect(await h.queryTraces({ traceId: "trace-nope" })).toEqual([]);
    expect(await h.queryTraces()).toHaveLength(3);
  });

  it("persists mask-redacted prompt/completion but the error verbatim", async () => {
    const h = getHarness();
    const policy = { mode: "mask" } as const;
    const rawPrompt = "my secret prompt content";
    const rawCompletion = "very confidential completion";
    h.sink.recordGeneration(
      gen({
        traceId: "trace-r",
        messages: [{ role: "user", content: rawPrompt }],
        completion: rawCompletion,
        status: "error",
        error: "err-already-redacted-by-caller",
        redaction: policy,
      }),
    );
    await h.flush();

    const [g] = await h.queryGenerations({ traceId: "trace-r" });
    expect(g?.messages[0]?.content).toBe(redactContent(rawPrompt, policy));
    expect(g?.messages[0]?.content).not.toContain("secret");
    expect(g?.completion).toBe(redactContent(rawCompletion, policy));
    expect(g?.completion).not.toContain("confidential");
    // The sink must NOT re-redact the caller-redacted error string.
    expect(g?.error).toBe("err-already-redacted-by-caller");
  });
}
