/**
 * Unit tests for {@link instrumentRawStream} — the onFinish/onError/onAbort
 * trace callbacks the streaming chat endpoint + AG-UI runner attach to their
 * caller-owned `streamText` calls.
 *
 * Strategy: install an {@link InMemoryAITraceStore} sink, invoke the returned
 * callbacks with SDK-shaped events, and assert exactly one (or zero, for abort)
 * generation lands with the right model/provider/tokens/status. Each callback
 * is asserted non-throwing — they run inside the SDK stream machinery, where a
 * throw would break the consumer's stream.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AITraceSink,
  InMemoryAITraceStore,
  resetAITraceSink,
  setAITraceSink,
} from "@linchkit/core/server";
import { CostEstimator } from "../src/cost-estimator";
import { instrumentRawStream } from "../src/stream-instrumentation";

let sink: InMemoryAITraceStore;

beforeEach(() => {
  sink = new InMemoryAITraceStore();
  setAITraceSink(sink);
});

afterEach(() => {
  resetAITraceSink();
});

const BASE = {
  provider: "zhipu",
  model: "glm-4-flash",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.3,
} as const;

describe("instrumentRawStream", () => {
  it("onFinish records one ok generation with tokens + cost + model/provider", () => {
    // Inject pricing for the test model so cost is a concrete number (the
    // default estimator has no glm-4-flash pricing → cost would be undefined).
    const costEstimator = new CostEstimator({
      "glm-4-flash": { inputPerToken: 1 / 1_000_000, outputPerToken: 2 / 1_000_000 },
    });
    const trace = instrumentRawStream({
      ...BASE,
      costEstimator,
      trace: { name: "assistant-chat" },
    });

    expect(() =>
      trace.onFinish({
        text: "hi there",
        totalUsage: { inputTokens: 12, outputTokens: 7 },
      }),
    ).not.toThrow();

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    const gen = gens[0];
    expect(gen?.status).toBe("ok");
    expect(gen?.partial).toBe(false);
    expect(gen?.model).toBe("glm-4-flash");
    expect(gen?.provider).toBe("zhipu");
    expect(gen?.inputTokens).toBe(12);
    expect(gen?.outputTokens).toBe(7);
    // 12 * 1e-6 + 7 * 2e-6 = 2.6e-5
    expect(gen?.cost).toBeCloseTo(2.6e-5, 10);
    expect(gen?.responseFormat).toBe("text");
  });

  it("onFinish tolerates a missing usage object (records zero tokens, still ok)", () => {
    const trace = instrumentRawStream(BASE);
    expect(() => trace.onFinish({ text: "no usage" })).not.toThrow();

    const gen = sink.query()[0];
    expect(gen?.status).toBe("ok");
    expect(gen?.inputTokens).toBe(0);
    expect(gen?.outputTokens).toBe(0);
  });

  it("onError records one partial/error generation with zero tokens", () => {
    const trace = instrumentRawStream(BASE);

    expect(() => trace.onError({ error: new Error("provider exploded") })).not.toThrow();

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    const gen = gens[0];
    expect(gen?.status).toBe("error");
    expect(gen?.partial).toBe(true);
    expect(gen?.inputTokens).toBe(0);
    expect(gen?.outputTokens).toBe(0);
    // The error message is stored but REDACTED by the sink (masked), so assert
    // it is captured (non-empty) rather than matching the raw text.
    expect(typeof gen?.error).toBe("string");
    expect(gen?.error?.length ?? 0).toBeGreaterThan(0);
  });

  it("onAbort records NO generation but does not throw", () => {
    const trace = instrumentRawStream(BASE);

    expect(() => trace.onAbort()).not.toThrow();
    expect(sink.query()).toHaveLength(0);
  });

  it("coerces message roles to the stored union (developer→system, tool→assistant)", () => {
    const trace = instrumentRawStream({
      ...BASE,
      messages: [
        { role: "developer", content: "system-ish instructions" },
        { role: "tool", content: "tool result" },
        { role: "user", content: "hi" },
      ],
    });
    trace.onFinish({ text: "ok", totalUsage: { inputTokens: 1, outputTokens: 1 } });

    const gen = sink.query()[0];
    expect(gen?.messages.map((m) => m.role)).toEqual(["system", "assistant", "user"]);
  });

  it("fail records one partial/error generation (synchronous streamText throw)", () => {
    const trace = instrumentRawStream(BASE);

    expect(() => trace.fail(new Error("streamText threw synchronously"))).not.toThrow();

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("error");
    expect(gens[0]?.partial).toBe(true);
  });

  it("fail is a no-op once a terminal callback already settled the trace", () => {
    const trace = instrumentRawStream(BASE);

    trace.onFinish({ text: "done", totalUsage: { inputTokens: 4, outputTokens: 2 } });
    trace.fail(new Error("late sync throw"));

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("ok");
  });

  it("is one-shot: the first terminal callback wins, later ones are ignored", () => {
    const trace = instrumentRawStream(BASE);

    trace.onFinish({ text: "done", totalUsage: { inputTokens: 5, outputTokens: 3 } });
    // A late error after a clean finish must NOT add a second record.
    trace.onError({ error: new Error("late") });
    trace.onAbort();

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("ok");
  });

  it("one-shot also holds when onError fires first", () => {
    const trace = instrumentRawStream(BASE);

    trace.onError({ error: new Error("first") });
    trace.onFinish({ text: "too late", totalUsage: { inputTokens: 9, outputTokens: 9 } });

    const gens = sink.query();
    expect(gens).toHaveLength(1);
    expect(gens[0]?.status).toBe("error");
  });

  it("stringifies non-string error values without throwing", () => {
    const trace = instrumentRawStream(BASE);
    expect(() => trace.onError({ error: { code: 500 } })).not.toThrow();
    expect(sink.query()[0]?.status).toBe("error");
  });

  it("never throws even when the sink itself throws", () => {
    const throwingSink: AITraceSink = {
      startTrace: () => {
        throw new Error("sink down");
      },
      endTrace: () => {
        throw new Error("sink down");
      },
      recordGeneration: () => {
        throw new Error("sink down");
      },
      query: () => [],
      queryTraces: () => [],
      size: 0,
      clear: () => {},
    };
    setAITraceSink(throwingSink);

    // onFinish's recording path swallows a throwing sink.
    expect(() =>
      instrumentRawStream(BASE).onFinish({
        text: "x",
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).not.toThrow();

    // onError's recording path (recordError + its `finally { parent.end }`) must
    // ALSO swallow a throwing sink. Use a FRESH instance so the one-shot latch
    // doesn't short-circuit onError before it enters recordError.
    expect(() => instrumentRawStream(BASE).onError({ error: new Error("y") })).not.toThrow();

    // And the synchronous fail() path shares recordError — verify it too.
    expect(() => instrumentRawStream(BASE).fail(new Error("z"))).not.toThrow();
  });
});
