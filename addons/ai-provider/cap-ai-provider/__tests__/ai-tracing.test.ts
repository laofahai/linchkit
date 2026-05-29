/**
 * Unit tests for the AI tracing seam (Spec 69 Phase 3).
 *
 * Focus on the two correctness properties that are awkward to prove through
 * the full service path:
 *  - FINDING B: a fractional sampling rate is rolled ONCE per trace. The parent
 *    decision is threaded into child generations (`forcedSampled`) instead of
 *    each call re-rolling, so a generation can never be sampled-in under a
 *    sampled-out parent (orphan) or vice-versa. Boundary rates 0/1 stay
 *    deterministic.
 *  - `redactError` applies the active policy + length cap.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
  AITraceContext,
  AITraceSamplingConfig,
  Observability,
  RedactionPolicy,
} from "@linchkit/core/server";
import {
  InMemoryAITraceStore,
  resetAITraceSink,
  resetObservability,
  setAITraceSink,
  setObservability,
} from "@linchkit/core/server";
import {
  openParentTrace,
  recordGeneration,
  redactError,
  resetTracingWarnLatch,
} from "../src/ai-tracing";

let sink: InMemoryAITraceStore;

function noopMeterPassthrough() {
  return {
    createCounter: () => ({ add: () => {} }),
    createHistogram: () => ({ record: () => {} }),
  };
}

beforeEach(() => {
  sink = new InMemoryAITraceStore();
  setAITraceSink(sink);
  setObservability({
    tracer: { startSpan: () => ({}) },
    meter: noopMeterPassthrough(),
  } as unknown as Observability);
  resetTracingWarnLatch();
});

afterEach(() => {
  resetObservability();
  resetAITraceSink();
});

/** Record one ok generation under a parent, threading the parent's decision. */
function recordUnder(traceId: string, sampled: boolean, samplingRate?: number): void {
  const now = Date.now();
  recordGeneration({
    traceId,
    context: { traceId, origin: "eval" },
    model: "m",
    provider: "p",
    messages: [{ role: "user", content: "hi" }],
    completion: "ok",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    status: "ok",
    startedAt: now,
    endedAt: now,
    forcedSampled: sampled,
    sampling: samplingRate === undefined ? undefined : { rate: samplingRate },
  });
}

describe("FINDING B — single sampling roll governs parent + child", () => {
  it("a single fractional roll sampled-OUT skips both parent and generation (deterministic RNG)", () => {
    // Force Math.random above the rate so the ONE roll lands sampled-out.
    const rng = spyOn(Math, "random").mockReturnValue(0.9);
    try {
      const parent = openParentTrace(
        { traceId: "t-out", origin: "eval" },
        { sampling: { rate: 0.5 } },
      );
      expect(parent.sampled).toBe(false);
      // Exactly one roll consumed by the parent — the generation must NOT roll.
      expect(rng).toHaveBeenCalledTimes(1);

      // Thread the parent decision down: nothing is recorded, no orphan trace.
      recordUnder(parent.traceId, parent.sampled);
      expect(rng).toHaveBeenCalledTimes(1);
      expect(sink.size).toBe(0);
      expect(sink.queryTraces()).toHaveLength(0);
    } finally {
      rng.mockRestore();
    }
  });

  it("a single fractional roll sampled-IN records both parent and generation (deterministic RNG)", () => {
    // Force Math.random below the rate so the ONE roll lands sampled-in.
    const rng = spyOn(Math, "random").mockReturnValue(0.1);
    try {
      const parent = openParentTrace(
        { traceId: "t-in", origin: "eval" },
        { sampling: { rate: 0.5 } },
      );
      expect(parent.sampled).toBe(true);
      expect(rng).toHaveBeenCalledTimes(1);

      recordUnder(parent.traceId, parent.sampled);
      // The generation reused the decision — no second roll.
      expect(rng).toHaveBeenCalledTimes(1);
      expect(sink.size).toBe(1);
      const traces = sink.queryTraces({ traceId: "t-in" });
      expect(traces).toHaveLength(1);
      expect(sink.query()[0]?.traceId).toBe("t-in");
    } finally {
      rng.mockRestore();
    }
  });

  it("forcedSampled OVERRIDES the per-generation sampling config (no independent re-roll)", () => {
    // Parent sampled-in, but the generation's own sampling config would say 0.
    // The threaded decision must win → the generation is still recorded, so a
    // child can never be dropped out from under a sampled-in parent.
    recordUnder("t1", true, /* samplingRate */ 0);
    expect(sink.query({ traceId: "t1" })).toHaveLength(1);

    // Parent sampled-out, but the generation's own config would say 1. The
    // threaded decision must win → nothing recorded, so no orphan generation.
    recordUnder("t2", false, /* samplingRate */ 1);
    expect(sink.query({ traceId: "t2" })).toHaveLength(0);
  });

  it("boundary rate 1 is deterministic (no RNG consumed)", () => {
    const rng = spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      const parent = openParentTrace(
        { traceId: "t-one", origin: "eval" },
        { sampling: { rate: 1 } },
      );
      expect(parent.sampled).toBe(true);
      expect(rng).not.toHaveBeenCalled();
    } finally {
      rng.mockRestore();
    }
  });

  it("boundary rate 0 is deterministic (no RNG consumed)", () => {
    const rng = spyOn(Math, "random").mockReturnValue(0);
    try {
      const parent = openParentTrace(
        { traceId: "t-zero", origin: "eval" },
        { sampling: { rate: 0 } },
      );
      expect(parent.sampled).toBe(false);
      expect(rng).not.toHaveBeenCalled();
    } finally {
      rng.mockRestore();
    }
  });
});

describe("FINDING 1/2 — setup throwing is swallowed, never escapes the AI call", () => {
  /**
   * A `context` whose `traceId` getter throws makes `resolveTraceContext`
   * (the FIRST setup step in both wrappers) throw — proving the guard covers
   * setup, not just the sink call. Typed as `AITraceContext` so no `any`.
   */
  function poisonedContext(): AITraceContext {
    return Object.defineProperty({} as AITraceContext, "traceId", {
      get(): never {
        throw new Error("boom from resolveTraceContext setup");
      },
      enumerable: true,
    });
  }

  /** A `sampling` config whose `rate` getter throws → `shouldSample` throws. */
  function poisonedSampling(): AITraceSamplingConfig {
    return Object.defineProperty({} as AITraceSamplingConfig, "rate", {
      get(): never {
        throw new Error("boom from shouldSample setup");
      },
      enumerable: true,
    });
  }

  it("openParentTrace does NOT throw when resolveTraceContext setup throws", () => {
    let handle: ReturnType<typeof openParentTrace> | undefined;
    expect(() => {
      handle = openParentTrace(poisonedContext());
    }).not.toThrow();
    // Inert fallback handle: a usable trace id + no-op end.
    expect(handle?.traceId).toBeTruthy();
    expect(handle?.sampled).toBe(true);
    expect(() => handle?.end()).not.toThrow();
  });

  it("openParentTrace does NOT throw when shouldSample setup throws", () => {
    expect(() => openParentTrace(undefined, { sampling: poisonedSampling() })).not.toThrow();
  });

  it("recordGeneration does NOT throw when resolveTraceContext setup throws (forced-sampled)", () => {
    const now = Date.now();
    expect(() =>
      recordGeneration({
        traceId: "t-poison",
        context: poisonedContext(),
        model: "m",
        provider: "p",
        messages: [{ role: "user", content: "hi" }],
        completion: "ok",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        startedAt: now,
        endedAt: now,
        forcedSampled: true,
      }),
    ).not.toThrow();
    // Setup threw before the sink call → nothing recorded, but no escape.
    expect(sink.size).toBe(0);
  });

  it("recordGeneration does NOT throw when the standalone sampling roll throws", () => {
    const now = Date.now();
    expect(() =>
      recordGeneration({
        traceId: "t-poison-sample",
        context: { traceId: "t-poison-sample", origin: "eval" },
        model: "m",
        provider: "p",
        messages: [{ role: "user", content: "hi" }],
        completion: "ok",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        startedAt: now,
        endedAt: now,
        // No forcedSampled → the standalone roll runs; its getter throws.
        sampling: poisonedSampling(),
      }),
    ).not.toThrow();
    // A failed roll falls back to not-sampled → nothing recorded.
    expect(sink.size).toBe(0);
  });

  it("recordGeneration does NOT throw when redaction (maskValue) throws via a poisoned override", () => {
    const now = Date.now();
    // A redactionOverride whose `mode` getter throws makes `resolveRedaction` /
    // the downstream redact path throw inside the guarded inner body.
    const poisonedRedaction = Object.defineProperty({} as RedactionPolicy, "mode", {
      get(): never {
        throw new Error("boom from redaction");
      },
      enumerable: true,
    });
    expect(() =>
      recordGeneration({
        traceId: "t-poison-redact",
        context: { traceId: "t-poison-redact", origin: "eval" },
        model: "m",
        provider: "p",
        messages: [{ role: "user", content: "hi" }],
        completion: "ok",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: "error",
        error: "secret",
        startedAt: now,
        endedAt: now,
        forcedSampled: true,
        redactionOverride: poisonedRedaction,
      }),
    ).not.toThrow();
  });
});

describe("redactError", () => {
  it("returns undefined for an undefined error", () => {
    expect(redactError(undefined, { mode: "mask" })).toBeUndefined();
  });

  it("returns undefined for a null error (FINDING 3)", () => {
    expect(redactError(null, { mode: "mask" })).toBeUndefined();
  });

  it("coerces a non-string error to a string before redaction (FINDING 3)", () => {
    // Provider SDKs usually pass `error.message`, but be defensive: a stray
    // number / Error object must not bypass redaction nor throw. Use a typed
    // wrapper that widens to the accepted union so no `any` leaks in.
    const asErrorArg = (value: unknown): string | null | undefined =>
      value as string | null | undefined;

    // Under `none` the coerced string is kept verbatim.
    expect(redactError(asErrorArg(123), { mode: "none" })).toBe("123");

    // Under `mask` the coerced string is redacted (does not survive verbatim).
    const masked = redactError(asErrorArg(new Error("sk-LEAKEDSECRET99")), {
      mode: "mask",
      visibleChars: 4,
    });
    expect(masked).toBeDefined();
    expect(masked).not.toContain("LEAKEDSECRET");
  });

  it("keeps the error verbatim under none", () => {
    const err = "401 Unauthorized: api_key=sk-SECRET";
    expect(redactError(err, { mode: "none" })).toBe(err);
  });

  it("masks the error under mask so a secret does not survive", () => {
    const out = redactError("api_key=sk-LEAKEDSECRET99", { mode: "mask", visibleChars: 4 });
    expect(out).toBeDefined();
    expect(out).not.toContain("LEAKEDSECRET");
    expect(out).not.toContain("sk-");
  });

  it("length-caps a runaway error string even under none", () => {
    const huge = "x".repeat(10_000);
    const out = redactError(huge, { mode: "none" });
    expect(out?.length).toBe(2_000);
  });
});
