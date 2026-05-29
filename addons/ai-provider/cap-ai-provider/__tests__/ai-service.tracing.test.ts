/**
 * Tracing instrumentation tests for createAIService (Spec 69 Phase 3, PR-1).
 *
 * Exercises the real `complete()` path end-to-end (executeWithFallback →
 * executeCompletion) using injected fake SDK runners so no network call is
 * made, plus a fake tracer (setObservability) and fake sink (setAITraceSink)
 * that are reset in afterEach.
 *
 * Verifies:
 *  - one generation recorded per complete() with correct tokens/cost/model/latency
 *  - a parent trace wraps the call (and survives fallback)
 *  - the error path records a generation with status "error"
 *  - sampling rate 0 records nothing
 *  - production-origin redaction masks the prompt; eval-origin keeps verbatim
 *  - a sink that THROWS does not break complete()
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
import { type AIServiceInternals, createAIService } from "../src/ai-service";
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

// ── Fake SDK runners (no network) ────────────────────────

const fakeUsage = { inputTokens: 11, outputTokens: 7 };

function textInternals(): AIServiceInternals {
  return {
    getModel: async () => ({ id: "fake-model" }),
    runGenerateText: async () => ({
      text: "the model reply text",
      usage: fakeUsage,
      toolCalls: [],
    }),
  };
}

function jsonInternals(): AIServiceInternals {
  return {
    getModel: async () => ({ id: "fake-model" }),
    runGenerateObject: async () => ({
      object: { answer: 42 },
      usage: fakeUsage,
    }),
  };
}

function throwingInternals(message: string): AIServiceInternals {
  return {
    getModel: async () => ({ id: "fake-model" }),
    runGenerateText: async () => {
      throw new Error(message);
    },
  };
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

// The fake observability only needs a tracer; reuse core's noop meter so the
// Observability shape is satisfied without re-implementing the meter.
function noopMeterPassthrough() {
  return {
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} }),
  };
}

// ── Tests ────────────────────────────────────────────────

describe("createAIService tracing — happy path", () => {
  it("records exactly one generation per complete() with correct usage/model/latency", async () => {
    const ai = createAIService(config, textInternals());
    const result = await ai.complete({
      messages: [{ role: "user", content: "hello" }],
      model: "fast",
    });

    expect(result.content).toBe("the model reply text");
    expect(sink.size).toBe(1);

    const gen = sink.query()[0];
    expect(gen?.model).toBe("claude-haiku-4-5-20251001");
    expect(gen?.provider).toBe("anthropic");
    expect(gen?.inputTokens).toBe(11);
    expect(gen?.outputTokens).toBe(7);
    expect(gen?.status).toBe("ok");
    expect(gen?.latencyMs).toBeGreaterThanOrEqual(0);
    // Cost computed from the cost estimator for a known model.
    expect(typeof gen?.cost).toBe("number");
    expect(gen?.cost).toBeGreaterThan(0);
  });

  it("opens a generation span on the tracer", async () => {
    const ai = createAIService(config, textInternals());
    await ai.complete({ messages: [{ role: "user", content: "hello" }] });

    const spanEntry = tracer.spans.find((s) => s.name === "linchkit.ai.generation");
    expect(spanEntry).toBeDefined();
    expect(spanEntry?.span.ended).toBe(true);
    expect(spanEntry?.span.status.code).toBe("ok");
    expect(spanEntry?.span.attributes["linchkit.ai.model"]).toBe("claude-haiku-4-5-20251001");
    expect(spanEntry?.span.attributes["linchkit.ai.input_tokens"]).toBe(11);
  });

  it("opens a parent trace that the generation belongs to", async () => {
    const ai = createAIService(config, textInternals());
    await ai.complete({ messages: [{ role: "user", content: "hello" }] });

    const traces = sink.queryTraces();
    expect(traces).toHaveLength(1);
    const gen = sink.query()[0];
    expect(gen?.traceId).toBe(traces[0]?.traceId);
    // Parent trace was finalized.
    expect(traces[0]?.endedAt).toBeDefined();
    expect(traces[0]?.status).toBe("ok");
  });

  it("records a json-mode generation", async () => {
    const { z } = await import("zod");
    const ai = createAIService(config, jsonInternals());
    const result = await ai.complete({
      messages: [{ role: "user", content: "give me 42" }],
      responseFormat: { type: "json", schema: z.object({ answer: z.number() }) },
    });

    expect(result.data).toEqual({ answer: 42 });
    expect(sink.size).toBe(1);
    expect(sink.query()[0]?.responseFormat).toBe("json");
  });
});

describe("createAIService tracing — redaction", () => {
  it("default production origin masks the prompt", async () => {
    const ai = createAIService(config, textInternals());
    await ai.complete({
      messages: [{ role: "user", content: "my password is hunter2" }],
    });
    const gen = sink.query()[0];
    expect(gen?.messages[0]?.content).not.toContain("hunter2");
    // Completion is masked too.
    expect(gen?.completion).not.toContain("reply");
  });

  it("eval origin keeps the prompt verbatim", async () => {
    const ai = createAIService(config, textInternals());
    await ai.complete({
      messages: [{ role: "user", content: "my password is hunter2" }],
      trace: { origin: "eval", scenario: "intent", fixtureId: "fx-1" },
    });
    const gen = sink.query()[0];
    expect(gen?.messages[0]?.content).toBe("my password is hunter2");
    expect(gen?.completion).toBe("the model reply text");
    const trace = sink.queryTraces()[0];
    expect(trace?.scenario).toBe("intent");
    expect(trace?.fixtureId).toBe("fx-1");
    expect(trace?.origin).toBe("eval");
  });
});

describe("createAIService tracing — fallback", () => {
  it("a parent trace wraps a fallback: primary fails, fallback succeeds", async () => {
    const fallbackConfig: AIServiceConfig = {
      defaultProvider: "primary",
      providers: {
        primary: { type: "openai", endpoint: "http://x", defaultModel: "p-model" },
        backup: { type: "openai", endpoint: "http://y", defaultModel: "b-model" },
      },
      fallback: { providers: ["backup"], retriesPerProvider: 1, retryDelay: 0 },
    };

    let calls = 0;
    const internals: AIServiceInternals = {
      getModel: async () => ({ id: "fake" }),
      runGenerateText: async () => {
        calls++;
        if (calls === 1) throw new Error("primary down");
        return { text: "from backup", usage: fakeUsage, toolCalls: [] };
      },
    };

    const ai = createAIService(fallbackConfig, internals);
    const result = await ai.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("from backup");
    expect(result.fallbackUsed).toBe("primary");

    // One trace parent, two generations (failed primary + ok backup) under it.
    const traces = sink.queryTraces();
    expect(traces).toHaveLength(1);
    const gens = sink.query({ traceId: traces[0]?.traceId });
    expect(gens).toHaveLength(2);
    expect(gens.filter((g) => g.status === "error")).toHaveLength(1);
    expect(gens.filter((g) => g.status === "ok")).toHaveLength(1);

    // FINDING E: the fallback-served SUCCESS generation records which provider
    // originally failed; the (primary) error generation does not.
    const okGen = gens.find((g) => g.status === "ok");
    const errGen = gens.find((g) => g.status === "error");
    expect(okGen?.fallbackUsed).toBe("primary");
    expect(errGen?.fallbackUsed).toBeUndefined();
  });
});

describe("createAIService tracing — error path", () => {
  it("records a generation with status error and re-throws", async () => {
    const ai = createAIService(config, throwingInternals("model exploded"));
    // eval origin keeps the error verbatim (trusted fixtures); production
    // masking is covered separately below.
    await expect(
      ai.complete({ messages: [{ role: "user", content: "hi" }], trace: { origin: "eval" } }),
    ).rejects.toThrow("model exploded");

    expect(sink.size).toBe(1);
    const gen = sink.query()[0];
    expect(gen?.status).toBe("error");
    expect(gen?.error).toContain("model exploded");
    // Parent trace finalized as error.
    expect(sink.queryTraces()[0]?.status).toBe("error");
  });

  it("redacts the error under production mask but keeps it verbatim under none (FINDING A)", async () => {
    // A provider 4xx that echoes a secret in its error string must not leak it
    // under the production `mask` policy.
    const leakyError = "401 Unauthorized: api_key=sk-LEAKEDSECRET99";

    // Production origin (default) → masked: the secret must not survive.
    const prodAi = createAIService(config, throwingInternals(leakyError));
    await expect(prodAi.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      leakyError,
    );
    const prodGen = sink.query()[0];
    expect(prodGen?.status).toBe("error");
    expect(prodGen?.error).toBeDefined();
    expect(prodGen?.error).not.toContain("sk-LEAKEDSECRET99");
    expect(prodGen?.error).not.toContain("LEAKEDSECRET");
    // The original (thrown) error is unchanged — only the stored copy is redacted.

    sink.clear();

    // Eval origin → verbatim (trusted fixtures).
    const evalAi = createAIService(config, throwingInternals(leakyError));
    await expect(
      evalAi.complete({ messages: [{ role: "user", content: "hi" }], trace: { origin: "eval" } }),
    ).rejects.toThrow(leakyError);
    const evalGen = sink.query()[0];
    expect(evalGen?.error).toBe(leakyError);
  });
});

describe("createAIService tracing — sampling", () => {
  it("sampling rate 0 records nothing", async () => {
    // Wire a sink that would throw if ever touched — proving rate-0 short-
    // circuits before the sink is reached (and complete() still succeeds).
    setAITraceSink({
      startTrace: () => {
        throw new Error("recordGeneration reached despite rate 0");
      },
      endTrace: () => {
        throw new Error("endTrace reached despite rate 0");
      },
      recordGeneration: () => {
        throw new Error("recordGeneration reached despite rate 0");
      },
      query: () => [],
      queryTraces: () => [],
      get size() {
        return 0;
      },
      clear: () => {},
    });

    const ai = createAIService(config, { ...textInternals(), sampling: { rate: 0 } });
    const result = await ai.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("the model reply text");
    // No tracer span opened either.
    expect(tracer.spans).toHaveLength(0);
  });

  it("sampling rate 1 records normally", async () => {
    const ai = createAIService(config, { ...textInternals(), sampling: { rate: 1 } });
    await ai.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(sink.size).toBe(1);
  });
});

describe("createAIService tracing — robustness", () => {
  it("a sink that THROWS does not break complete()", async () => {
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

    const ai = createAIService(config, textInternals());
    const result = await ai.complete({ messages: [{ role: "user", content: "hi" }] });
    // The AI call returns normally despite every sink method throwing.
    expect(result.content).toBe("the model reply text");
    expect(result.usage.inputTokens).toBe(11);
  });

  it("a tracer that THROWS does not break complete()", async () => {
    setObservability({
      tracer: {
        startSpan: () => {
          throw new Error("tracer boom");
        },
      },
      meter: noopMeterPassthrough(),
    } as Observability);

    const ai = createAIService(config, textInternals());
    const result = await ai.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("the model reply text");
    // Sink still recorded despite tracer failure (span + record are isolated).
    expect(sink.size).toBe(1);
  });
});
