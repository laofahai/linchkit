/**
 * Tests for InMemoryAITraceStore + the sink registry (Spec 69 Phase 3).
 *
 * Covers: record/query/filter, ring-buffer trim, tenant isolation, clear,
 * redaction modes applied at record time, aggregate roll-up, trace lifecycle,
 * and the getAITraceSink/setAITraceSink/resetAITraceSink singleton.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AITraceMessage, RecordGenerationParams } from "../ai-trace";
import { EVAL_REDACTION, PRODUCTION_REDACTION } from "../ai-trace";
import {
  getAITraceSink,
  InMemoryAITraceStore,
  NoopAITraceSink,
  noopAITraceSink,
  resetAITraceSink,
  setAITraceSink,
} from "../ai-trace-store";

const messages: AITraceMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "user secret message" },
];

function baseGen(overrides: Partial<RecordGenerationParams> = {}): RecordGenerationParams {
  const now = Date.now();
  return {
    traceId: "trace-1",
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    messages,
    completion: "assistant reply",
    inputTokens: 10,
    outputTokens: 5,
    cost: 0.0001,
    latencyMs: 42,
    responseFormat: "text",
    status: "ok",
    startedAt: now,
    endedAt: now + 42,
    redaction: EVAL_REDACTION,
    ...overrides,
  };
}

describe("InMemoryAITraceStore — record & query", () => {
  it("records a generation and auto-opens its parent trace", () => {
    const store = new InMemoryAITraceStore();
    const gen = store.recordGeneration(baseGen());

    expect(store.size).toBe(1);
    expect(gen.traceId).toBe("trace-1");
    expect(gen.inputTokens).toBe(10);
    expect(gen.outputTokens).toBe(5);
    expect(gen.cost).toBeCloseTo(0.0001);
    expect(gen.model).toBe("claude-haiku-4-5-20251001");

    const traces = store.queryTraces({ traceId: "trace-1" });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.inputTokens).toBe(10);
    expect(traces[0]?.outputTokens).toBe(5);
  });

  it("rolls up aggregate tokens + cost across generations under one trace", () => {
    const store = new InMemoryAITraceStore();
    store.startTrace({ traceId: "t", name: "parent" });
    store.recordGeneration(baseGen({ traceId: "t", inputTokens: 10, outputTokens: 2, cost: 0.01 }));
    store.recordGeneration(baseGen({ traceId: "t", inputTokens: 20, outputTokens: 3, cost: 0.02 }));

    const trace = store.queryTraces({ traceId: "t" })[0];
    expect(trace?.inputTokens).toBe(30);
    expect(trace?.outputTokens).toBe(5);
    expect(trace?.cost).toBeCloseTo(0.03);
  });

  it("query returns most recent first and honors limit", () => {
    const store = new InMemoryAITraceStore();
    store.recordGeneration(baseGen({ traceId: "a", model: "m-a" }));
    store.recordGeneration(baseGen({ traceId: "b", model: "m-b" }));
    store.recordGeneration(baseGen({ traceId: "c", model: "m-c" }));

    const all = store.query();
    expect(all.map((g) => g.model)).toEqual(["m-c", "m-b", "m-a"]);

    const limited = store.query({ limit: 2 });
    expect(limited.map((g) => g.model)).toEqual(["m-c", "m-b"]);
  });

  it("filters by model, status, and traceId", () => {
    const store = new InMemoryAITraceStore();
    store.recordGeneration(baseGen({ traceId: "x", model: "gpt-4o" }));
    store.recordGeneration(
      baseGen({ traceId: "y", model: "claude", status: "error", error: "boom" }),
    );

    expect(store.query({ model: "gpt-4o" })).toHaveLength(1);
    expect(store.query({ status: "error" })).toHaveLength(1);
    expect(store.query({ traceId: "y" })[0]?.error).toBe("boom");
  });

  it("after/before are STRICT bounds (exclusive), matching the JSDoc (FINDING D)", () => {
    const store = new InMemoryAITraceStore();
    // Open the parent with an explicit startedAt so the trace time is
    // deterministic (auto-open would stamp Date.now()).
    store.startTrace({ traceId: "g", name: "n", startedAt: 100 });
    store.recordGeneration(baseGen({ traceId: "g", model: "m", startedAt: 100, endedAt: 100 }));

    // Equal-to the boundary is excluded (strict > / <).
    expect(store.query({ after: 100 })).toHaveLength(0);
    expect(store.query({ before: 100 })).toHaveLength(0);
    // Strictly inside the window is included.
    expect(store.query({ after: 99 })).toHaveLength(1);
    expect(store.query({ before: 101 })).toHaveLength(1);

    // queryTraces shares the same strict semantics (trace startedAt == 100).
    expect(store.queryTraces({ after: 100 })).toHaveLength(0);
    expect(store.queryTraces({ before: 100 })).toHaveLength(0);
    expect(store.queryTraces({ after: 99 })).toHaveLength(1);
    expect(store.queryTraces({ before: 101 })).toHaveLength(1);
  });
});

describe("InMemoryAITraceStore — tenant isolation", () => {
  it("isolates generations by tenant via parent trace", () => {
    const store = new InMemoryAITraceStore();
    store.startTrace({ traceId: "ta", name: "a", tenantId: "tenant-a" });
    store.startTrace({ traceId: "tb", name: "b", tenantId: "tenant-b" });
    store.recordGeneration(baseGen({ traceId: "ta" }));
    store.recordGeneration(baseGen({ traceId: "tb" }));

    expect(store.query({ tenantId: "tenant-a" })).toHaveLength(1);
    expect(store.query({ tenantId: "tenant-b" })).toHaveLength(1);
    expect(store.query({ tenantId: "tenant-c" })).toHaveLength(0);

    expect(store.queryTraces({ tenantId: "tenant-a" })).toHaveLength(1);
  });

  it("filters traces by scenario and origin", () => {
    const store = new InMemoryAITraceStore();
    store.startTrace({ traceId: "e", name: "n", scenario: "intent", origin: "eval" });
    store.startTrace({ traceId: "p", name: "n", scenario: "chat", origin: "production" });

    expect(store.queryTraces({ scenario: "intent" })).toHaveLength(1);
    expect(store.queryTraces({ origin: "eval" })).toHaveLength(1);
    expect(store.queryTraces({ origin: "production" })).toHaveLength(1);
  });
});

describe("InMemoryAITraceStore — ring-buffer trim", () => {
  it("trims oldest half when generation capacity is exceeded", () => {
    const store = new InMemoryAITraceStore({ maxGenerations: 4, maxTraces: 1000 });
    for (let i = 0; i < 5; i++) {
      store.recordGeneration(baseGen({ traceId: `t${i}`, model: `m${i}` }));
    }
    // At the 5th record, length was 4 (== cap) so it trimmed 2, leaving 2,
    // then pushed the 5th → 3 entries remain.
    expect(store.size).toBeLessThanOrEqual(4);
    expect(store.size).toBe(3);
    // The newest is retained.
    expect(store.query({ limit: 1 })[0]?.model).toBe("m4");
  });

  it("rejects non-positive capacity", () => {
    expect(() => new InMemoryAITraceStore({ maxGenerations: 0 })).toThrow(RangeError);
    expect(() => new InMemoryAITraceStore({ maxTraces: -1 })).toThrow(RangeError);
  });
});

describe("InMemoryAITraceStore — redaction at record time", () => {
  it("eval redaction stores prompt + completion verbatim", () => {
    const store = new InMemoryAITraceStore();
    const gen = store.recordGeneration(baseGen({ redaction: EVAL_REDACTION }));
    expect(gen.messages[1]?.content).toBe("user secret message");
    expect(gen.completion).toBe("assistant reply");
  });

  it("production (mask) redaction masks prompt + completion", () => {
    const store = new InMemoryAITraceStore();
    const gen = store.recordGeneration(baseGen({ redaction: PRODUCTION_REDACTION }));
    expect(gen.messages[1]?.content).not.toContain("secret");
    expect(gen.messages[1]?.content.endsWith("age")).toBe(true);
    expect(gen.completion).not.toContain("assistant");
  });

  it("hash redaction hashes prompt content", () => {
    const store = new InMemoryAITraceStore();
    const gen = store.recordGeneration(baseGen({ redaction: { mode: "hash" } }));
    expect(gen.messages[1]?.content).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drop redaction empties prompt content", () => {
    const store = new InMemoryAITraceStore();
    const gen = store.recordGeneration(baseGen({ redaction: { mode: "drop" } }));
    expect(gen.messages.every((m) => m.content === "")).toBe(true);
    expect(gen.completion).toBe("");
  });
});

describe("InMemoryAITraceStore — lifecycle & clear", () => {
  it("endTrace finalizes endedAt + status", () => {
    const store = new InMemoryAITraceStore();
    store.startTrace({ traceId: "t", name: "n" });
    store.endTrace({ traceId: "t", status: "error", endedAt: 12345 });
    const trace = store.queryTraces({ traceId: "t" })[0];
    expect(trace?.endedAt).toBe(12345);
    expect(trace?.status).toBe("error");
  });

  it("error generation escalates parent trace status to error", () => {
    const store = new InMemoryAITraceStore();
    store.startTrace({ traceId: "t", name: "n" });
    store.recordGeneration(baseGen({ traceId: "t", status: "error", error: "x" }));
    expect(store.queryTraces({ traceId: "t" })[0]?.status).toBe("error");
  });

  it("clear empties everything", () => {
    const store = new InMemoryAITraceStore();
    store.recordGeneration(baseGen());
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.query()).toHaveLength(0);
    expect(store.queryTraces()).toHaveLength(0);
  });

  it("startTrace is idempotent for the same id", () => {
    const store = new InMemoryAITraceStore();
    const id1 = store.startTrace({ traceId: "dup", name: "first" });
    const id2 = store.startTrace({ traceId: "dup", name: "second" });
    expect(id1).toBe("dup");
    expect(id2).toBe("dup");
    expect(store.queryTraces({ traceId: "dup" })).toHaveLength(1);
    // First wins — not overwritten.
    expect(store.queryTraces({ traceId: "dup" })[0]?.name).toBe("first");
  });
});

describe("NoopAITraceSink", () => {
  it("records nothing but returns a usable record", () => {
    const sink = new NoopAITraceSink();
    const gen = sink.recordGeneration(baseGen());
    expect(gen.traceId).toBe("trace-1");
    expect(sink.size).toBe(0);
    expect(sink.query()).toHaveLength(0);
    expect(sink.queryTraces()).toHaveLength(0);
  });
});

describe("sink registry singleton", () => {
  afterEach(() => {
    resetAITraceSink();
  });

  it("defaults to the noop sink", () => {
    expect(getAITraceSink()).toBe(noopAITraceSink);
  });

  it("setAITraceSink swaps the active sink and returns the previous", () => {
    const store = new InMemoryAITraceStore();
    const prev = setAITraceSink(store);
    expect(prev).toBe(noopAITraceSink);
    expect(getAITraceSink()).toBe(store);
  });

  it("resetAITraceSink restores the noop default", () => {
    setAITraceSink(new InMemoryAITraceStore());
    resetAITraceSink();
    expect(getAITraceSink()).toBe(noopAITraceSink);
  });
});
