/**
 * Streaming-path tracing tests for createAIService (Spec 69 Phase 3, P3).
 *
 * Exercises the real `completeStream()` path using an injected fake
 * `runStreamText` runner (no network), plus a fake tracer (setObservability)
 * and an in-memory sink (setAITraceSink) reset in afterEach.
 *
 * The streaming path now records token-ACCURATE accounting once the stream
 * finishes draining (instead of the zero-token partial-at-open of PR-1):
 *  - a CLEAN drain records exactly ONE `partial: false` / `status: "ok"`
 *    generation with correct input/output tokens, cost, and completion text;
 *  - an ABORTING / erroring stream records ONE `partial: true` /
 *    `status: "error"` record and re-throws to the consumer WITHOUT the tracing
 *    layer ever throwing on its own;
 *  - the parent trace token/cost rollup matches the recorded generation;
 *  - a sink that THROWS never breaks the consumer's stream;
 *  - sampling rate 0 records nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
  AIServiceConfig,
  Observability,
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "@linchkit/core/server";
import {
  InMemoryAITraceStore,
  resetAITraceSink,
  resetObservability,
  setAITraceSink,
  setObservability,
} from "@linchkit/core/server";
import { type AIServiceInternals, createAIService, type StreamTextLike } from "../src/ai-service";
import { resetTracingWarnLatch } from "../src/ai-tracing";

// ── Fake tracer ──────────────────────────────────────────

class FakeSpan implements Span {
  attributes: SpanAttributes = {};
  status: SpanStatus = { code: "unset" };
  exceptions: string[] = [];
  ended = false;
  setAttribute(key: string, value: SpanAttributeValue): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.attributes, attrs);
    return this;
  }
  recordException(error: Error | string): this {
    this.exceptions.push(error instanceof Error ? error.message : error);
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  end(): void {
    this.ended = true;
  }
  isRecording(): boolean {
    return !this.ended;
  }
}

class FakeTracer implements Tracer {
  spans: { name: string; span: FakeSpan; options?: StartSpanOptions }[] = [];
  startSpan(name: string, options?: StartSpanOptions): Span {
    const span = new FakeSpan();
    if (options?.attributes) span.setAttributes(options.attributes);
    this.spans.push({ name, span, options });
    return span;
  }
}

// ── Fake stream runner (no network) ──────────────────────

/**
 * Build a fake {@link StreamTextLike}: yields the given chunks lazily, then
 * resolves `totalUsage` / `text` ONLY after the stream is fully drained
 * (mirroring the SDK's "automatically consumes the stream" accessors). The
 * usage promise resolves with the concatenated chunks counted as a sanity check
 * is left to the caller — the runner just reports the configured usage.
 */
function fakeStream(args: {
  chunks: string[];
  usage: { inputTokens?: number; outputTokens?: number };
  /** Optionally make `text` reject to prove the chunk-accumulation fallback. */
  textRejects?: boolean;
}): StreamTextLike {
  let drained = false;
  const fullText = args.chunks.join("");
  return {
    textStream: (async function* () {
      for (const c of args.chunks) {
        yield c;
      }
      drained = true;
    })(),
    get totalUsage() {
      return Promise.resolve(args.usage);
    },
    get text() {
      if (args.textRejects) return Promise.reject(new Error("text accessor unavailable"));
      // Resolve only when the stream actually drained — asserts ordering.
      return drained
        ? Promise.resolve(fullText)
        : Promise.reject(new Error("text read before drain"));
    },
  };
}

/**
 * A fake stream that throws partway through iteration (simulates an abort or a
 * mid-stream provider error). The consumer's `for await` surfaces the throw.
 */
function erroringStream(args: {
  chunksBeforeError: string[];
  errorMessage: string;
}): StreamTextLike {
  return {
    textStream: (async function* () {
      for (const c of args.chunksBeforeError) {
        yield c;
      }
      throw new Error(args.errorMessage);
    })(),
    get totalUsage() {
      // Should NEVER be awaited on the error path — usage is unknown.
      return Promise.reject(new Error("totalUsage must not be read on the error path"));
    },
    get text() {
      return Promise.reject(new Error("text must not be read on the error path"));
    },
  };
}

function streamInternals(stream: StreamTextLike): AIServiceInternals {
  return {
    getModel: async () => ({ id: "fake-model" }),
    runStreamText: () => stream,
  };
}

/** Drain an async iterable into the concatenated string. */
async function drain(textStream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of textStream) out += chunk;
  return out;
}

/**
 * The fire-and-forget finish recording runs in a microtask after the consumer
 * finishes draining. Yield to the event loop so the recording settles before
 * assertions read the sink.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Config ───────────────────────────────────────────────

const config: AIServiceConfig = {
  defaultProvider: "anthropic",
  providers: {
    anthropic: {
      defaultModel: "claude-haiku-4-5-20251001",
      models: { fast: "claude-haiku-4-5-20251001" },
    },
  },
};

// ── Harness ──────────────────────────────────────────────

let tracer: FakeTracer;
let sink: InMemoryAITraceStore;

beforeEach(() => {
  tracer = new FakeTracer();
  sink = new InMemoryAITraceStore();
  setObservability({ tracer, meter: noopMeterPassthrough() } as Observability);
  setAITraceSink(sink);
  resetTracingWarnLatch();
});

afterEach(() => {
  resetObservability();
  resetAITraceSink();
});

function noopMeterPassthrough() {
  return {
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} }),
  };
}

// ── Tests ────────────────────────────────────────────────

describe("createAIService streaming tracing — clean drain", () => {
  it("records exactly one accurate partial:false generation after the stream drains", async () => {
    const ai = createAIService(
      config,
      streamInternals(
        fakeStream({
          chunks: ["Hello", " ", "world"],
          usage: { inputTokens: 13, outputTokens: 9 },
        }),
      ),
    );

    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "say hi" }],
      model: "fast",
      trace: { origin: "eval" },
    });
    expect(stream).toBeDefined();
    if (!stream) return;

    // No generation is recorded at stream OPEN — accounting waits for drain.
    expect(sink.size).toBe(0);

    const text = await drain(stream.textStream);
    expect(text).toBe("Hello world");
    await flushMicrotasks();

    // Exactly one generation, with ACCURATE tokens/cost/completion.
    expect(sink.size).toBe(1);
    const gen = sink.query()[0];
    expect(gen?.partial).toBe(false);
    expect(gen?.status).toBe("ok");
    expect(gen?.model).toBe("claude-haiku-4-5-20251001");
    expect(gen?.provider).toBe("anthropic");
    expect(gen?.inputTokens).toBe(13);
    expect(gen?.outputTokens).toBe(9);
    // eval origin keeps the completion verbatim.
    expect(gen?.completion).toBe("Hello world");
    // Cost computed from the SAME estimator the completion path uses.
    expect(typeof gen?.cost).toBe("number");
    expect(gen?.cost).toBeGreaterThan(0);
    expect(gen?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rolls the accurate usage/cost up to the parent trace", async () => {
    const ai = createAIService(
      config,
      streamInternals(fakeStream({ chunks: ["abc"], usage: { inputTokens: 20, outputTokens: 5 } })),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    await drain(stream.textStream);
    await flushMicrotasks();

    const traces = sink.queryTraces();
    expect(traces).toHaveLength(1);
    const gen = sink.query()[0];
    expect(traces[0]?.traceId).toBe(gen?.traceId);
    expect(traces[0]?.inputTokens).toBe(20);
    expect(traces[0]?.outputTokens).toBe(5);
    expect(traces[0]?.cost).toBe(gen?.cost ?? 0);
    // Parent finalized as ok.
    expect(traces[0]?.endedAt).toBeDefined();
    expect(traces[0]?.status).toBe("ok");
  });

  it("opens a generation span with accurate token attributes after drain", async () => {
    const ai = createAIService(
      config,
      streamInternals(fakeStream({ chunks: ["hi"], usage: { inputTokens: 4, outputTokens: 2 } })),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    await drain(stream.textStream);
    await flushMicrotasks();

    const spanEntry = tracer.spans.find((s) => s.name === "linchkit.ai.generation");
    expect(spanEntry).toBeDefined();
    expect(spanEntry?.span.ended).toBe(true);
    expect(spanEntry?.span.status.code).toBe("ok");
    expect(spanEntry?.span.attributes["linchkit.ai.input_tokens"]).toBe(4);
    expect(spanEntry?.span.attributes["linchkit.ai.output_tokens"]).toBe(2);
    expect(spanEntry?.span.attributes["linchkit.ai.partial"]).toBe(false);
  });

  it("falls back to accumulated chunks when the SDK text accessor rejects", async () => {
    const ai = createAIService(
      config,
      streamInternals(
        fakeStream({
          chunks: ["part-A", "part-B"],
          usage: { inputTokens: 3, outputTokens: 3 },
          textRejects: true,
        }),
      ),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    const text = await drain(stream.textStream);
    expect(text).toBe("part-Apart-B");
    await flushMicrotasks();

    const gen = sink.query()[0];
    expect(gen?.status).toBe("ok");
    expect(gen?.partial).toBe(false);
    // Tokens still accurate; completion falls back to accumulated chunks.
    expect(gen?.inputTokens).toBe(3);
    expect(gen?.completion).toBe("part-Apart-B");
  });

  it("coerces undefined provider usage fields to zero", async () => {
    const ai = createAIService(config, streamInternals(fakeStream({ chunks: ["z"], usage: {} })));
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    await drain(stream.textStream);
    await flushMicrotasks();

    const gen = sink.query()[0];
    expect(gen?.inputTokens).toBe(0);
    expect(gen?.outputTokens).toBe(0);
  });

  it("records a successful generation with 0 tokens when totalUsage rejects after a clean drain", async () => {
    // A clean drain is a SUCCESS even if the usage accessor is unavailable (some
    // providers omit usage on streams). The generation must still be recorded
    // (0 tokens) and the parent trace ended "ok" — NOT dropped + marked errored.
    const ai = createAIService(config, {
      getModel: async () => ({ id: "fake-model" }),
      runStreamText: () => ({
        textStream: (async function* () {
          yield "a";
          yield "b";
        })(),
        get totalUsage() {
          return Promise.reject(new Error("usage unavailable"));
        },
        get text() {
          return Promise.resolve("ab");
        },
      }),
    });
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    const text = await drain(stream.textStream);
    expect(text).toBe("ab");
    await flushMicrotasks();

    expect(sink.size).toBe(1);
    const gen = sink.query()[0];
    expect(gen?.status).toBe("ok");
    expect(gen?.partial).toBe(false);
    expect(gen?.inputTokens).toBe(0);
    expect(gen?.outputTokens).toBe(0);
    expect(gen?.completion).toBe("ab");
    // Parent finalized "ok" despite the usage rejection.
    expect(sink.queryTraces()[0]?.status).toBe("ok");
  });
});

describe("createAIService streaming tracing — abort / error", () => {
  it("records a single partial:true error generation and re-throws to the consumer", async () => {
    const ai = createAIService(
      config,
      streamInternals(
        erroringStream({ chunksBeforeError: ["start"], errorMessage: "stream exploded" }),
      ),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");

    // The consumer's iteration surfaces the stream's own error (tracing does
    // NOT swallow it).
    await expect(drain(stream.textStream)).rejects.toThrow("stream exploded");
    await flushMicrotasks();

    expect(sink.size).toBe(1);
    const gen = sink.query()[0];
    expect(gen?.partial).toBe(true);
    expect(gen?.status).toBe("error");
    expect(gen?.error).toContain("stream exploded");
    expect(gen?.inputTokens).toBe(0);
    expect(gen?.outputTokens).toBe(0);
    // Completion holds the chunks received before the error.
    expect(gen?.completion).toBe("start");
    // Parent trace finalized as error.
    expect(sink.queryTraces()[0]?.status).toBe("error");
  });

  it("a consumer that stops early (return) finalizes the parent trace without throwing", async () => {
    const ai = createAIService(
      config,
      streamInternals(
        fakeStream({ chunks: ["a", "b", "c"], usage: { inputTokens: 1, outputTokens: 1 } }),
      ),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");

    // Consume only the first chunk, then break — the wrapper generator's
    // `return()` runs its `finally` clean-up without throwing into the consumer.
    let first: string | undefined;
    for await (const chunk of stream.textStream) {
      first = chunk;
      break;
    }
    expect(first).toBe("a");
    await flushMicrotasks();

    // Early break does not drain the stream, so NO generation is recorded
    // (usage is unknown — awaiting it could hang).
    expect(sink.size).toBe(0);
    // ...but the parent trace MUST still be finalized: an opened `startTrace`
    // without a matching `endTrace` would leak an open trace forever. The
    // `finally` ends it as "ok" (no error occurred, the consumer just stopped).
    const trace = sink.queryTraces()[0];
    expect(trace).toBeDefined();
    expect(trace?.status).toBe("ok");
    expect(trace?.endedAt).toBeDefined();
  });

  it("finalizes the parent trace as error when stream acquisition throws", async () => {
    // The parent trace is opened BEFORE the stream is acquired. If acquisition
    // throws (SDK import rejects / streamText throws synchronously), the
    // consumer never gets a stream to drain, so the wrapper's own finalizer can
    // never run — executeStream must finalize the parent itself.
    const ai = createAIService(config, {
      getModel: async () => ({ id: "fake-model" }),
      runStreamText: () => {
        throw new Error("streamText boom");
      },
    });

    await expect(
      ai.completeStream?.({
        messages: [{ role: "user", content: "x" }],
        trace: { origin: "eval" },
      }),
    ).rejects.toThrow("streamText boom");

    // No generation recorded (the stream never started)...
    expect(sink.size).toBe(0);
    // ...but the opened parent trace MUST be finalized as error, not leaked open.
    const trace = sink.queryTraces()[0];
    expect(trace).toBeDefined();
    expect(trace?.status).toBe("error");
    expect(trace?.endedAt).toBeDefined();
  });
});

describe("createAIService streaming tracing — robustness", () => {
  it("a sink that THROWS never breaks the consumer's stream", async () => {
    setAITraceSink({
      startTrace: () => {
        throw new Error("sink.startTrace boom");
      },
      endTrace: () => {
        throw new Error("sink.endTrace boom");
      },
      recordGeneration: () => {
        throw new Error("sink.recordGeneration boom");
      },
      query: () => {
        throw new Error("nope");
      },
      queryTraces: () => {
        throw new Error("nope");
      },
      get size() {
        return 0;
      },
      clear: () => {},
    });

    const ai = createAIService(
      config,
      streamInternals(
        fakeStream({ chunks: ["ok", "!"], usage: { inputTokens: 2, outputTokens: 1 } }),
      ),
    );
    const stream = await ai.completeStream?.({ messages: [{ role: "user", content: "x" }] });
    if (!stream) throw new Error("no stream");
    // The stream drains to the full output despite every sink method throwing.
    const text = await drain(stream.textStream);
    expect(text).toBe("ok!");
    await flushMicrotasks();
  });

  it("a tracer that THROWS never breaks the consumer's stream", async () => {
    setObservability({
      tracer: {
        startSpan: () => {
          throw new Error("tracer boom");
        },
      },
      meter: noopMeterPassthrough(),
    } as Observability);

    const ai = createAIService(
      config,
      streamInternals(fakeStream({ chunks: ["ok"], usage: { inputTokens: 2, outputTokens: 1 } })),
    );
    const stream = await ai.completeStream?.({
      messages: [{ role: "user", content: "x" }],
      trace: { origin: "eval" },
    });
    if (!stream) throw new Error("no stream");
    const text = await drain(stream.textStream);
    expect(text).toBe("ok");
    await flushMicrotasks();
    // Sink still recorded despite the tracer span failing (span + record are
    // isolated from each other).
    expect(sink.size).toBe(1);
    expect(sink.query()[0]?.outputTokens).toBe(1);
  });

  it("sampling rate 0 records nothing for a stream", async () => {
    const ai = createAIService(config, {
      ...streamInternals(fakeStream({ chunks: ["x"], usage: { inputTokens: 1, outputTokens: 1 } })),
      sampling: { rate: 0 },
    });
    const stream = await ai.completeStream?.({ messages: [{ role: "user", content: "x" }] });
    if (!stream) throw new Error("no stream");
    const text = await drain(stream.textStream);
    expect(text).toBe("x");
    await flushMicrotasks();
    expect(sink.size).toBe(0);
    expect(tracer.spans).toHaveLength(0);
  });
});
