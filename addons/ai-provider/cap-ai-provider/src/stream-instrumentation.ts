/**
 * Trace instrumentation for caller-owned raw `streamText` calls.
 *
 * The {@link createAIService} `completeStream` path instruments its stream by
 * WRAPPING the SDK `textStream` (it owns iteration, so it records after a clean
 * drain). But the transport-layer assistant paths — the streaming `/api/ai/chat`
 * endpoint and the AG-UI agent runner — call the Vercel AI SDK `streamText`
 * DIRECTLY (they need tools, multi-step, `fullStream`, and
 * `toUIMessageStreamResponse()`), so wrapping `textStream` is not an option:
 * the HTTP response / AG-UI translator consumes the stream, not our code.
 *
 * The SDK exposes the terminal callbacks `onFinish` / `onError` / `onAbort`
 * instead. {@link instrumentRawStream} opens ONE parent trace and returns those
 * callbacks (plus a {@link RawStreamInstrumentation.fail} escape hatch for a
 * synchronous `streamText` throw) pre-wired to {@link recordGeneration}, so a
 * caller spreads them straight into its own `streamText({ ... })` call and the
 * generation lands in the SAME trace sink as `completeStream` — without
 * altering the stream's content, ordering, or timing.
 *
 * Every callback is STRICTLY non-throwing: it runs inside the SDK's stream
 * machinery, so a throw could break the consumer's stream. A one-shot `settled`
 * latch guarantees AT MOST one terminal callback records.
 */

import type { AIMessage, AITraceContext, AITraceSamplingConfig } from "@linchkit/core";
import {
  logTracingError,
  openParentTrace,
  type ParentTraceHandle,
  recordGeneration,
} from "./ai-tracing";
import { type CostEstimator, defaultCostEstimator } from "./cost-estimator";

/** A prompt message in the shape the tracer records (role + stringifiable content). */
export interface RawStreamMessage {
  readonly role: string;
  readonly content: unknown;
}

/** Options for {@link instrumentRawStream}. */
export interface InstrumentRawStreamOptions {
  /**
   * Trace context. `origin` defaults to `"production"`; `name` is a
   * human-readable label (e.g. `"assistant-chat"`); `tenantId` / `actorId`
   * forward isolation + provenance to the sink.
   */
  readonly trace?: AITraceContext;
  /** Resolved provider name (e.g. `"zhipu"`). */
  readonly provider: string;
  /** Resolved model id (e.g. `"glm-4-flash"`). */
  readonly model: string;
  /** Prompt messages sent to the model (recorded raw, redacted by the sink). */
  readonly messages: readonly RawStreamMessage[];
  readonly temperature?: number;
  /** Cost estimator. Defaults to the shared {@link defaultCostEstimator}. */
  readonly costEstimator?: CostEstimator;
  /** Sampling config — rolled ONCE for the parent trace and threaded down. */
  readonly sampling?: AITraceSamplingConfig;
}

/** Aggregated token usage, as exposed on the SDK `streamText` finish event. */
interface StreamUsageLike {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * The subset of the SDK `streamText` `onFinish` event this module reads. Kept
 * structurally minimal (all optional) so the real `OnFinishEvent<TOOLS>` — which
 * has these fields and more — is assignable to it, letting the callback spread
 * into `streamText({ onFinish })` without an `any` cast.
 */
interface StreamFinishEventLike {
  readonly text?: string;
  /** Usage aggregated across all steps (preferred). */
  readonly totalUsage?: StreamUsageLike;
  /** Single-step usage (fallback when `totalUsage` is absent). */
  readonly usage?: StreamUsageLike;
}

/**
 * The terminal callbacks the caller spreads into `streamText`, plus `fail` for
 * a synchronous `streamText` throw (before any callback can fire).
 */
export interface RawStreamInstrumentation {
  readonly onFinish: (event: StreamFinishEventLike) => void;
  readonly onError: (event: { error: unknown }) => void;
  readonly onAbort: () => void;
  /**
   * Finalize as errored when the caller's `streamText` throws SYNCHRONOUSLY,
   * before any terminal callback can fire — otherwise the parent trace opened
   * at construction would leak open. One-shot (no-op once settled), so it is
   * safe to call from a catch that also overlaps a fired callback.
   */
  readonly fail: (error: unknown) => void;
}

/** Coerce an arbitrary role to the strict union the sink stores (default assistant). */
function coerceRole(role: string): AIMessage["role"] {
  return role === "system" || role === "user" || role === "assistant" ? role : "assistant";
}

/** Coerce arbitrary model-message content to the string shape the sink stores. */
function coerceMessages(messages: readonly RawStreamMessage[]): AIMessage[] {
  return messages.map((m) => ({
    role: coerceRole(m.role),
    content: typeof m.content === "string" ? m.content : safeStringify(m.content),
  }));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Build the terminal callbacks for a caller-owned raw `streamText` call so it
 * records ONE generation to the active trace sink.
 *
 * - `onFinish(event)` — clean completion. Reads `event.totalUsage` (aggregated
 *   across steps) + `event.text` and records `partial: false` / `status: "ok"`
 *   with cost computed by the SAME estimator the completion path uses.
 * - `onError({ error })` / `fail(error)` — stream error (async) or a
 *   synchronous `streamText` throw. Records `partial: true` / `status: "error"`
 *   with zero tokens (usage is unknown), mirroring the completion error path.
 * - `onAbort()` — consumer aborted (client disconnect). Usage never resolves on
 *   a non-drained stream, so NO generation is recorded; the parent trace is
 *   finalized so it is never left open (mirrors `completeStream`'s abandon path).
 *
 * A one-shot `settled` latch ensures at most one callback records, and every
 * callback swallows its own errors so tracing can never break the stream.
 */
export function instrumentRawStream(opts: InstrumentRawStreamOptions): RawStreamInstrumentation {
  const startTime = Date.now();
  const costEstimator = opts.costEstimator ?? defaultCostEstimator;
  const messages = coerceMessages(opts.messages);
  // Open the parent trace ONCE so the generation lands under a parent and the
  // sampling decision rolls a single die (threaded down via `forcedSampled`).
  // Non-throwing — returns an inert handle on failure.
  const parent: ParentTraceHandle = openParentTrace(opts.trace, { sampling: opts.sampling });
  let settled = false;

  // Record a partial/error generation (shared by the async onError and the
  // synchronous fail path). Strictly non-throwing — `parent.end` finalizes even
  // if the (already non-throwing) recordGeneration or estimator misbehaves.
  const recordError = (error: unknown): void => {
    try {
      const endedAt = Date.now();
      recordGeneration({
        traceId: parent.traceId,
        context: opts.trace,
        model: opts.model,
        provider: opts.provider,
        messages,
        completion: "",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: endedAt - startTime,
        temperature: opts.temperature,
        responseFormat: "text",
        partial: true,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        startedAt: startTime,
        endedAt,
        sampling: opts.sampling,
        forcedSampled: parent.sampled,
      });
    } catch (err) {
      logTracingError("raw-stream-error", err);
    } finally {
      parent.end("error");
    }
  };

  const onFinish = (event: StreamFinishEventLike): void => {
    if (settled) return;
    settled = true;
    try {
      const endedAt = Date.now();
      const usage = event.totalUsage ?? event.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const completion = typeof event.text === "string" ? event.text : "";
      recordGeneration({
        traceId: parent.traceId,
        context: opts.trace,
        model: opts.model,
        provider: opts.provider,
        messages,
        completion,
        inputTokens,
        outputTokens,
        cost: costEstimator.estimateCost(opts.model, inputTokens, outputTokens),
        latencyMs: endedAt - startTime,
        temperature: opts.temperature,
        responseFormat: "text",
        partial: false,
        status: "ok",
        startedAt: startTime,
        endedAt,
        sampling: opts.sampling,
        forcedSampled: parent.sampled,
      });
      parent.end("ok");
    } catch (err) {
      // recordGeneration is itself non-throwing; this guards estimateCost and
      // keeps the SDK callback from ever throwing into the consumer's stream.
      logTracingError("raw-stream-finish", err);
      parent.end("error");
    }
  };

  const onError = (event: { error: unknown }): void => {
    if (settled) return;
    settled = true;
    recordError(event.error);
  };

  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    // Usage / text never resolve on a non-drained stream, so do NOT record a
    // generation (awaiting them could hang the recorder). Just finalize the
    // parent so a started trace is never left without a matching end.
    parent.end("ok");
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    recordError(error);
  };

  return { onFinish, onError, onAbort, fail };
}
