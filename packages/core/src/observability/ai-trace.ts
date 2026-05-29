/**
 * AI Trace — in-house "Langfuse-class" tracing data model (Spec 69 Phase 3).
 *
 * Pure types + redaction helpers. NO storage, NO UI, NO OTLP mapping here —
 * those live in sibling modules / later PRs. This file builds on the existing
 * observability seam (`tracer.ts` / `observability-registry.ts`):
 *
 *  - `AITrace` is the parent unit of work (one user request / one eval fixture)
 *    that may fan out into multiple `AIGeneration` records (retries, fallback,
 *    multi-step). It mirrors Langfuse's trace → generation hierarchy without a
 *    third-party dependency.
 *  - `AIGeneration` is a single provider round-trip with usage / cost / latency
 *    and (optionally redacted) prompt + completion content.
 *  - `AITraceContext` is the lightweight metadata a caller attaches to an AI
 *    call (`AICompletionOptions.trace`) so the instrumentation seam can stamp
 *    generations with scenario / fixture / eval-run provenance.
 *
 * Redaction is applied at record time so a sink never persists raw prompts in
 * production. Sampling lets high-volume production traffic record only a
 * fraction while eval runs record everything.
 */

import { maskValue } from "../security/masking-engine";

// ── Status ───────────────────────────────────────────────

/** Lifecycle status of a trace or generation. */
export type AITraceStatus = "ok" | "error" | "partial";

// ── Redaction ────────────────────────────────────────────

/**
 * How prompt / completion content is transformed before it is handed to a
 * sink:
 *  - `none`  — store verbatim (use for eval origin where fixtures are trusted).
 *  - `mask`  — partial mask (keep a few trailing chars; the production default).
 *  - `hash`  — replace with a SHA-256 hex digest (stable, irreversible, lets
 *              you correlate identical prompts without storing them).
 *  - `drop`  — replace with an empty string (store nothing but the shape).
 */
export type RedactionMode = "none" | "hash" | "drop" | "mask";

/** Redaction policy applied to a generation's prompt + completion content. */
export interface RedactionPolicy {
  /** Strategy for user/assistant/system message content. */
  readonly mode: RedactionMode;
  /**
   * For `mask`, how many trailing characters stay visible. Ignored by other
   * modes. Defaults to 4 (mirrors the masking-engine `partial` default).
   */
  readonly visibleChars?: number;
}

/** Default redaction policy for production-origin traffic. */
export const PRODUCTION_REDACTION: RedactionPolicy = Object.freeze({ mode: "mask" });

/** Default redaction policy for eval-origin traffic (trusted fixtures). */
export const EVAL_REDACTION: RedactionPolicy = Object.freeze({ mode: "none" });

// ── Sampling ─────────────────────────────────────────────

/**
 * Sampling configuration. `rate` is the fraction of traces/generations to
 * record, in `[0, 1]`. `0` records nothing, `1` records everything.
 */
export interface AITraceSamplingConfig {
  /** Recording probability in [0, 1]. Clamped on use. */
  readonly rate: number;
}

/** Default sampling — record everything. */
export const DEFAULT_SAMPLING: AITraceSamplingConfig = Object.freeze({ rate: 1 });

// ── Trace context (caller-attached metadata) ─────────────

/** Where an AI call originated — drives the default redaction policy. */
export type AITraceOrigin = "production" | "eval";

/**
 * Metadata a caller attaches to an AI call via `AICompletionOptions.trace`.
 * Every field is optional so attaching a context is cheap; the instrumentation
 * seam fills in concrete usage/latency.
 */
export interface AITraceContext {
  /** Pre-allocated trace id to group generations under a parent trace. */
  readonly traceId?: string;
  /** Human-readable trace name (e.g. "intent"). */
  readonly name?: string;
  /** Scenario label (eval framework: scenario name). */
  readonly scenario?: string;
  /** Fixture id when this call replays a recorded fixture. */
  readonly fixtureId?: string;
  /** Free-form tags for filtering (e.g. fixture tags). */
  readonly tags?: readonly string[];
  /** Eval-run id grouping a batch of fixtures. */
  readonly evalRunId?: string;
  /** Model alias / id the caller pinned (for provenance labeling). */
  readonly model?: string;
  /** Origin — defaults to "production" when unset. */
  readonly origin?: AITraceOrigin;
  /** Tenant id (forwarded for tenant isolation in the sink). */
  readonly tenantId?: string;
  /** Acting user / agent id. */
  readonly actorId?: string;
  /** Additional structured metadata. */
  readonly metadata?: Record<string, unknown>;
}

// ── Generation ───────────────────────────────────────────

/** A single (possibly redacted) prompt message stored on a generation. */
export interface AITraceMessage {
  readonly role: "system" | "user" | "assistant";
  /** Redacted content per the active `RedactionPolicy`. */
  readonly content: string;
}

/**
 * One provider round-trip. Recorded after usage / latency are known. Prompt
 * and completion content are redacted per the active policy before storage.
 */
export interface AIGeneration {
  /** Unique generation id. */
  readonly id: string;
  /** Parent trace id this generation belongs to. */
  readonly traceId: string;
  /** Resolved model id used. */
  readonly model: string;
  /** Provider name used. */
  readonly provider: string;
  /** Redacted prompt messages. */
  readonly messages: readonly AITraceMessage[];
  /** Redacted completion text (empty when unavailable, e.g. streaming). */
  readonly completion: string;
  /** Prompt tokens consumed. */
  readonly inputTokens: number;
  /** Completion tokens produced. */
  readonly outputTokens: number;
  /** Estimated cost in USD (undefined when pricing unavailable). */
  readonly cost?: number;
  /** Wall-clock latency in milliseconds. */
  readonly latencyMs: number;
  /** Sampling temperature, when supplied by the caller. */
  readonly temperature?: number;
  /** Response format requested ("text" | "json"). */
  readonly responseFormat?: "text" | "json";
  /** Provider that originally failed, when a fallback served this generation. */
  readonly fallbackUsed?: string;
  /** Whether the result was served from cache. */
  readonly cached?: boolean;
  /** Whether this is a partial record (e.g. streaming, usage unknown). */
  readonly partial?: boolean;
  /** Generation status. */
  readonly status: AITraceStatus;
  /** Error message when status is "error". */
  readonly error?: string;
  /** When this generation started (epoch ms). */
  readonly startedAt: number;
  /** When this generation ended (epoch ms). */
  readonly endedAt: number;
}

// ── Trace ────────────────────────────────────────────────

/**
 * A parent unit of work grouping one or more generations. Aggregate token /
 * cost counters are maintained by the sink as generations are recorded.
 */
export interface AITrace {
  /** Unique trace id. */
  readonly traceId: string;
  /** Human-readable name. */
  readonly name: string;
  /** Tenant id (for isolation). */
  readonly tenantId?: string;
  /** Acting user / agent id. */
  readonly actorId?: string;
  /** Scenario label. */
  readonly scenario?: string;
  /** Fixture id when replaying a recorded fixture. */
  readonly fixtureId?: string;
  /** Eval-run id grouping a batch of fixtures. */
  readonly evalRunId?: string;
  /** Origin — production vs eval. */
  readonly origin: AITraceOrigin;
  /** Free-form tags for filtering. */
  readonly tags?: readonly string[];
  /** Additional structured metadata. */
  readonly metadata?: Record<string, unknown>;
  /** When the trace started (epoch ms). */
  readonly startedAt: number;
  /** When the trace ended (epoch ms); undefined while open. */
  readonly endedAt?: number;
  /** Aggregate input tokens across all generations. */
  readonly inputTokens: number;
  /** Aggregate output tokens across all generations. */
  readonly outputTokens: number;
  /** Aggregate estimated cost in USD across all generations. */
  readonly cost: number;
  /** Whether this trace was sampled in (recorded). */
  readonly sampled: boolean;
  /** Overall trace status. */
  readonly status: AITraceStatus;
}

// ── Sink interface ───────────────────────────────────────

/** Parameters for opening a trace. */
export interface StartTraceParams {
  /** Pre-allocated trace id; generated when omitted. */
  traceId?: string;
  name: string;
  tenantId?: string;
  actorId?: string;
  scenario?: string;
  fixtureId?: string;
  evalRunId?: string;
  origin?: AITraceOrigin;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
  /** Whether this trace was sampled in. Defaults to true. */
  sampled?: boolean;
  /** Explicit start time (epoch ms); defaults to now. */
  startedAt?: number;
}

/** Parameters for closing a trace. */
export interface EndTraceParams {
  traceId: string;
  status?: AITraceStatus;
  /** Explicit end time (epoch ms); defaults to now. */
  endedAt?: number;
}

/**
 * Parameters for recording a generation. The sink applies aggregation and
 * redacts `messages` + `completion`; callers pass those two RAW.
 *
 * Redaction-responsibility contract (so a sink never double-redacts):
 *  - `messages` / `completion` — RAW. The SINK redacts them using `redaction`.
 *  - `error` — ALREADY redacted by the caller (the provider wrapper redacts it
 *    with the SAME policy + a length cap, since 4xx strings can echo the
 *    request body / auth headers). The sink MUST NOT re-redact `error`:
 *    re-masking or re-hashing an already-redacted string would corrupt it.
 */
export interface RecordGenerationParams {
  traceId: string;
  model: string;
  provider: string;
  /** RAW prompt messages — redacted by the sink per `redaction`. */
  messages: readonly AITraceMessage[];
  /** RAW completion text — redacted by the sink per `redaction`. */
  completion: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  latencyMs: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  fallbackUsed?: string;
  cached?: boolean;
  partial?: boolean;
  status: AITraceStatus;
  /**
   * Error message — ALREADY redacted + length-capped by the caller. The sink
   * stores it verbatim and MUST NOT re-redact it (see the interface note).
   */
  error?: string;
  startedAt: number;
  endedAt: number;
  /** Tenant id (for isolation, when no parent trace was opened). */
  tenantId?: string;
  /** Redaction policy the sink applies to `messages` + `completion`. */
  redaction: RedactionPolicy;
}

/** Filters for querying recorded traces / generations. */
export interface AITraceQueryOptions {
  /** Filter by tenant id. */
  tenantId?: string;
  /** Filter by trace id. */
  traceId?: string;
  /** Filter by scenario label. */
  scenario?: string;
  /** Filter by origin. */
  origin?: AITraceOrigin;
  /** Filter by model id. */
  model?: string;
  /** Filter by status. */
  status?: AITraceStatus;
  /** Filter records started strictly after this epoch ms (exclusive). */
  after?: number;
  /** Filter records started strictly before this epoch ms (exclusive). */
  before?: number;
  /** Maximum records to return (most recent first). */
  limit?: number;
}

/**
 * Sink for AI traces + generations. Mirrors the
 * `startSpan`/`end` lifecycle of the tracer seam but persists structured AI
 * records. Implementations MUST be non-throwing-safe from the caller's
 * perspective is enforced at the call site, not here — a sink MAY throw and
 * the instrumentation wraps it.
 */
export interface AITraceSink {
  /** Open a parent trace. Returns the (possibly generated) trace id. */
  startTrace(params: StartTraceParams): string;
  /** Close a parent trace, finalizing aggregate status / endedAt. */
  endTrace(params: EndTraceParams): void;
  /** Record a single generation under a trace (auto-opens a trace if needed). */
  recordGeneration(params: RecordGenerationParams): AIGeneration;
  /** Query recorded generations with filters (most recent first). */
  query(options?: AITraceQueryOptions): AIGeneration[];
  /** Query recorded traces with filters (most recent first). */
  queryTraces(options?: AITraceQueryOptions): AITrace[];
  /** Total recorded generation count. */
  readonly size: number;
  /** Clear all recorded data (for testing). */
  clear(): void;
}

// ── Redaction helper ─────────────────────────────────────

/**
 * Redact a single content string per the active policy. Pure — no I/O.
 *
 * `mask` / `hash` delegate to the masking-engine primitives so redaction
 * stays consistent with field-level data masking elsewhere in core.
 */
export function redactContent(content: string, policy: RedactionPolicy): string {
  switch (policy.mode) {
    case "none":
      return content;
    case "drop":
      return "";
    case "hash":
      // maskValue("hash") returns a sha256 hex digest; never null for strings.
      return maskValue(content, "hash") ?? "";
    case "mask": {
      // Empty string masks to empty; preserve that rather than emitting "***".
      if (content.length === 0) return "";
      return (
        maskValue(content, "partial", {
          visibleChars: policy.visibleChars ?? 4,
          position: "end",
        }) ?? ""
      );
    }
    default:
      return "";
  }
}

/**
 * Redact an array of prompt messages per the active policy. Pure — returns a
 * new array with each message's `content` transformed; roles are preserved.
 */
export function redactPromptMessages(
  messages: readonly AITraceMessage[],
  policy: RedactionPolicy,
): AITraceMessage[] {
  return messages.map((m) => ({ role: m.role, content: redactContent(m.content, policy) }));
}

/**
 * Resolve the default redaction policy for an origin: production masks,
 * eval keeps verbatim. Callers may override with an explicit policy.
 */
export function defaultRedactionFor(origin: AITraceOrigin | undefined): RedactionPolicy {
  return origin === "eval" ? EVAL_REDACTION : PRODUCTION_REDACTION;
}

/**
 * Decide whether to record, given a sampling config. Pure given an injected
 * RNG (defaults to `Math.random`) so tests can be deterministic.
 */
export function shouldSample(
  config: AITraceSamplingConfig | undefined,
  rng: () => number = Math.random,
): boolean {
  const rate = config?.rate ?? DEFAULT_SAMPLING.rate;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return rng() < rate;
}
