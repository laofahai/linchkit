/**
 * AI tracing seam (Spec 69 Phase 3, PR-1).
 *
 * Thin, STRICTLY non-throwing wrappers around the core observability seam
 * (`getObservability().tracer` + `getAITraceSink()`). Every export here
 * swallows its own errors and logs once — a misbehaving tracer or sink must
 * NEVER break a real AI call. This module is the single place
 * `ai-service.ts` reaches into observability, keeping the service file focused
 * on provider orchestration.
 *
 * Hierarchy:
 *   • `openParentTrace()` opens an `AITrace` once per `executeWithFallback`
 *     call so retries + fallback land under one parent.
 *   • `recordGeneration()` records one `AIGeneration` per `executeCompletion`
 *     attempt (success or error), opens a per-generation tracer span, and
 *     applies redaction + sampling.
 */

import type { AICompletionResult, AIMessage, AITraceContext, AITraceStatus } from "@linchkit/core";
import {
  type AITraceMessage,
  type AITraceSamplingConfig,
  consoleLogger,
  defaultRedactionFor,
  getAITraceSink,
  getCurrentTrace,
  getObservability,
  type RedactionPolicy,
  redactContent,
  shouldSample,
} from "@linchkit/core/server";

const TRACE_SPAN_NAME = "linchkit.ai.generation";

/**
 * Hard upper bound on a stored error string (characters). Provider SDKs can
 * echo the full request body in 4xx error messages; cap before storage so a
 * single record cannot balloon the ring buffer even after redaction.
 */
const MAX_ERROR_LENGTH = 2_000;

/**
 * Mint a trace id, guarding against an environment where `crypto.randomUUID`
 * is unavailable (or itself throws). Used for the inert fallback handle so even
 * the id-generation step in the non-throwing wrappers can never escape.
 */
function fallbackTraceId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the time/random id below.
  }
  return `trace-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Redact a provider error before storage. Mirrors the message / completion
 * redaction so an error that echoes the request body / auth headers does not
 * bypass the active `RedactionPolicy`. For `none` the string is kept verbatim
 * (trusted eval origin); every other mode applies `redactContent`. Always
 * length-capped so a runaway error cannot bloat a record.
 *
 * Defensive about its input: returns `undefined` for both `undefined` and
 * `null`, and coerces a non-string error (provider SDKs usually pass
 * `error.message`, but some throw non-`Error` values) to a string before
 * capping + redaction so a stray `Error`/object can never bypass redaction.
 */
export function redactError(
  error: string | null | undefined,
  policy: RedactionPolicy,
): string | undefined {
  if (error == null) return undefined;
  const s = typeof error === "string" ? error : String(error);
  const capped = s.length > MAX_ERROR_LENGTH ? s.slice(0, MAX_ERROR_LENGTH) : s;
  if (policy.mode === "none") return capped;
  return redactContent(capped, policy);
}

/** Resolved tracing inputs derived from `options.trace` + the ambient trace. */
export interface ResolvedTraceContext {
  /** Parent trace id (caller-supplied, ambient, or freshly generated). */
  readonly traceId: string;
  /** Origin — drives the default redaction policy. */
  readonly origin: "production" | "eval";
  /** Caller-attached context (may be undefined). */
  readonly context: AITraceContext | undefined;
}

/**
 * Resolve the effective trace context for a call. Prefers an explicit
 * `options.trace`, falls back to the ambient `getCurrentTrace()` trace id,
 * and finally mints a fresh trace id so a generation always has a parent.
 */
export function resolveTraceContext(context: AITraceContext | undefined): ResolvedTraceContext {
  let ambientId: string | undefined;
  try {
    ambientId = getCurrentTrace()?.traceId;
  } catch {
    ambientId = undefined;
  }
  const traceId = context?.traceId ?? ambientId ?? crypto.randomUUID();
  return {
    traceId,
    origin: context?.origin ?? "production",
    context,
  };
}

/** Pick the redaction policy: explicit override → origin default. */
export function resolveRedaction(
  resolved: ResolvedTraceContext,
  override?: RedactionPolicy,
): RedactionPolicy {
  return override ?? defaultRedactionFor(resolved.origin);
}

/** Non-throwing handle returned by `openParentTrace`. */
export interface ParentTraceHandle {
  /** Parent trace id (so the caller can thread it into child generations). */
  readonly traceId: string;
  /**
   * The single sampling decision for this trace. Thread it into every child
   * `recordGeneration` (via `forcedSampled`) so a fractional rate rolls ONCE
   * per trace — never independently for parent vs generation, which would
   * orphan a sampled-in generation under a sampled-out parent (or vice-versa).
   */
  readonly sampled: boolean;
  /** Finalize the parent trace. Non-throwing. */
  end(status?: AITraceStatus): void;
}

/**
 * Open a parent trace once per top-level completion call. Resolves the
 * sampling decision ONCE here and returns it on the handle so child
 * generations reuse it instead of re-rolling. Returns the parent trace id (so
 * the caller can thread it into child generations) plus a non-throwing `end()`
 * finalizer. On any failure it logs once and returns an inert handle so the AI
 * call proceeds unaffected.
 */
export function openParentTrace(
  context: AITraceContext | undefined,
  options?: { sampling?: AITraceSamplingConfig },
): ParentTraceHandle {
  // The ENTIRE body is wrapped: `resolveTraceContext` / `shouldSample` /
  // `crypto.randomUUID` all run here, so any throw from setup (not just the
  // sink) must be swallowed — a tracing failure can NEVER escape into the AI
  // call. On failure, return an inert handle whose `end()` is a no-op and whose
  // `sampled: true` lets the caller still thread a (harmless) decision down.
  try {
    const resolved = resolveTraceContext(context);
    const sampled = shouldSample(options?.sampling);
    if (!sampled) {
      return { traceId: resolved.traceId, sampled: false, end: () => {} };
    }
    const sink = getAITraceSink();
    const traceId = sink.startTrace({
      traceId: resolved.traceId,
      name: context?.name ?? context?.scenario ?? "ai.completion",
      tenantId: context?.tenantId,
      actorId: context?.actorId,
      scenario: context?.scenario,
      fixtureId: context?.fixtureId,
      evalRunId: context?.evalRunId,
      origin: resolved.origin,
      tags: context?.tags,
      metadata: context?.metadata,
      sampled: true,
    });
    return {
      traceId,
      sampled: true,
      end: (status?: AITraceStatus) => {
        try {
          getAITraceSink().endTrace({ traceId, status });
        } catch (err) {
          logTracingError("endTrace", err);
        }
      },
    };
  } catch (err) {
    logTracingError("openParentTrace", err);
    return { traceId: fallbackTraceId(), sampled: true, end: () => {} };
  }
}

/** Inputs for recording one generation. */
export interface RecordGenerationInput {
  /** Parent trace id (from `openParentTrace`, or resolved standalone). */
  readonly traceId: string;
  readonly context: AITraceContext | undefined;
  readonly model: string;
  readonly provider: string;
  readonly messages: readonly AIMessage[];
  readonly completion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost?: number;
  readonly latencyMs: number;
  readonly temperature?: number;
  readonly responseFormat?: "text" | "json";
  readonly fallbackUsed?: string;
  readonly cached?: boolean;
  readonly partial?: boolean;
  readonly status: AITraceStatus;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly sampling?: AITraceSamplingConfig;
  readonly redactionOverride?: RedactionPolicy;
  /**
   * Sampling decision inherited from the parent trace (`openParentTrace`).
   * When set, it OVERRIDES `sampling` so a fractional rate is rolled once per
   * trace, never again per generation. Leave undefined only for standalone
   * generations with no parent (e.g. the stream path).
   */
  readonly forcedSampled?: boolean;
}

/**
 * Record one generation: open a tracer span, apply sampling + redaction, and
 * push to the active sink. STRICTLY non-throwing — any error is logged once
 * and swallowed.
 */
export function recordGeneration(input: RecordGenerationInput): void {
  // A parent trace decides sampling ONCE and threads the decision down via
  // `forcedSampled`; only roll a fresh die for standalone generations. Keep
  // this short-circuit cheap and FIRST: `input.forcedSampled` is a plain bool,
  // and for a sampled-out trace we want to do zero work. `shouldSample` here
  // only runs for standalone generations (no parent decision); a throw from it
  // is caught by the outer guard below — but the common path never reaches it.
  const sampled = input.forcedSampled ?? safeShouldSample(input.sampling);
  if (!sampled) {
    return;
  }
  // The remaining body is wrapped: `resolveTraceContext` / `resolveRedaction` /
  // `redactError` (and `maskValue` underneath) all run here, so a throw from
  // ANY of them must be swallowed rather than escaping into the AI call. The
  // span and sink each keep their own inner try/catch so a failure in one does
  // not skip the other.
  try {
    recordGenerationInner(input);
  } catch (err) {
    logTracingError("recordGeneration", err);
  }
}

/**
 * `shouldSample` for the standalone (no-parent) path. Wrapped so a throw from
 * the sampling roll itself cannot escape `recordGeneration` before the main
 * guard is even entered. A failed roll falls back to "not sampled" — dropping a
 * record is always safe; never breaking the AI call is the invariant.
 */
function safeShouldSample(sampling: AITraceSamplingConfig | undefined): boolean {
  try {
    return shouldSample(sampling);
  } catch (err) {
    logTracingError("shouldSample", err);
    return false;
  }
}

/**
 * Inner body of {@link recordGeneration}, run inside the outer non-throwing
 * guard. Resolves redaction, opens a tracer span, and pushes to the sink. The
 * span and sink calls keep their own try/catch so a failure in one is isolated
 * from the other.
 */
function recordGenerationInner(input: RecordGenerationInput): void {
  const resolved = resolveTraceContext(input.context);
  const origin = resolved.origin;
  const redaction = resolveRedaction(resolved, input.redactionOverride);
  // Redact the provider error ONCE with the same policy as messages/completion
  // and reuse it for both the span and the sink record so neither leaks an
  // unredacted error (4xx strings can echo the request body / auth headers).
  const redactedError = redactError(input.error, redaction);

  // Tracer span — best-effort, isolated from the sink record.
  try {
    const span = getObservability().tracer.startSpan(TRACE_SPAN_NAME, {
      kind: "client",
      startTime: input.startedAt,
      attributes: {
        "linchkit.ai.trace_id": input.traceId,
        "linchkit.ai.model": input.model,
        "linchkit.ai.provider": input.provider,
        "linchkit.ai.input_tokens": input.inputTokens,
        "linchkit.ai.output_tokens": input.outputTokens,
        "linchkit.ai.latency_ms": input.latencyMs,
        "linchkit.ai.origin": origin,
        ...(input.cost !== undefined ? { "linchkit.ai.cost_usd": input.cost } : {}),
        ...(input.fallbackUsed ? { "linchkit.ai.fallback_used": input.fallbackUsed } : {}),
        ...(input.cached !== undefined ? { "linchkit.ai.cached": input.cached } : {}),
        ...(input.partial !== undefined ? { "linchkit.ai.partial": input.partial } : {}),
      },
    });
    if (input.status === "error") {
      span.setStatus({ code: "error", message: redactedError });
      if (redactedError) span.recordException(redactedError);
    } else {
      span.setStatus({ code: "ok" });
    }
    span.end(input.endedAt);
  } catch (err) {
    logTracingError("span", err);
  }

  // Structured sink record — isolated from the span above.
  //
  // Redaction-responsibility split (see also `RecordGenerationParams` in
  // ai-trace.ts):
  //  - `messages` / `completion` are passed RAW here; the SINK redacts them
  //    using the `redaction` policy supplied below.
  //  - `error` is passed ALREADY redacted (by `redactError` above); the sink
  //    MUST NOT re-redact it — re-masking/re-hashing an already-redacted string
  //    would corrupt it (double-mask / hash-of-a-hash).
  try {
    const sinkMessages: AITraceMessage[] = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    getAITraceSink().recordGeneration({
      traceId: input.traceId,
      model: input.model,
      provider: input.provider,
      messages: sinkMessages,
      completion: input.completion,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cost: input.cost,
      latencyMs: input.latencyMs,
      temperature: input.temperature,
      responseFormat: input.responseFormat,
      fallbackUsed: input.fallbackUsed,
      cached: input.cached,
      partial: input.partial,
      status: input.status,
      // Pre-redacted with the SAME policy as messages/completion: 4xx error
      // strings can echo the request body / auth headers, so under `mask` this
      // must not bypass redaction. Length-capped for any mode.
      error: redactedError,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      tenantId: input.context?.tenantId,
      redaction,
    });
  } catch (err) {
    logTracingError("recordGeneration", err);
  }
}

/**
 * Convenience: record a successful generation from an `AICompletionResult`.
 * Used by the success branch after `executeCompletion` returns.
 */
export function recordSuccess(params: {
  result: AICompletionResult;
  context: AITraceContext | undefined;
  traceId: string;
  messages: readonly AIMessage[];
  startedAt: number;
  endedAt: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  sampling?: AITraceSamplingConfig;
  /** Parent-trace sampling decision threaded down (see `ParentTraceHandle`). */
  forcedSampled?: boolean;
  /**
   * Provider that originally failed when a fallback served this success.
   * `executeCompletion` records BEFORE `executeWithFallback` stamps
   * `result.fallbackUsed`, so the flag is threaded in explicitly here; falls
   * back to `result.fallbackUsed` when already set.
   */
  fallbackUsed?: string;
}): void {
  // The argument object below reads nested `result.usage.*` fields; those reads
  // happen at THIS call site, BEFORE `recordGeneration`'s internal guard is
  // entered, so a malformed `result` (e.g. missing `usage`) would throw out of
  // the AI call. Guard the whole projection here. STRICTLY non-throwing.
  try {
    const { result } = params;
    recordGeneration({
      traceId: params.traceId,
      context: params.context,
      model: result.model,
      provider: result.provider,
      messages: params.messages,
      completion: result.content,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cost: result.usage.cost,
      latencyMs: result.duration,
      temperature: params.temperature,
      responseFormat: params.responseFormat,
      fallbackUsed: params.fallbackUsed ?? result.fallbackUsed,
      cached: result.cached,
      status: "ok",
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      sampling: params.sampling,
      forcedSampled: params.forcedSampled,
    });
  } catch (err) {
    logTracingError("recordSuccess", err);
  }
}

let warnedOnce = false;

/** Log a tracing failure once per process at warn level, then go quiet. */
function logTracingError(stage: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  try {
    consoleLogger.warn(
      `[ai-tracing] ${stage} failed (further tracing errors suppressed): ${message}`,
    );
  } catch {
    // consoleLogger itself failed — nothing more we can safely do.
  }
}

/** Reset the once-only warning latch (test helper). */
export function resetTracingWarnLatch(): void {
  warnedOnce = false;
}
