/**
 * AI Trace Store — in-memory `AITraceSink` (Spec 69 Phase 3).
 *
 * Mirrors the ring-buffer pattern of `AIActionAuditStore`: bounded capacity,
 * trim-oldest-half on overflow, tenant isolation via query filters, frozen
 * records for immutability. Stores both parent `AITrace`s and child
 * `AIGeneration`s; recording a generation auto-opens (or reuses) its parent
 * trace and rolls up aggregate token / cost counters.
 *
 * Also provides a noop sink + a module-level singleton registry mirroring
 * `observability-registry.ts` so the provider-wrapper instrumentation can call
 * `getAITraceSink().recordGeneration(...)` with zero setup, and tests can swap
 * in a fake via `setAITraceSink()` / `resetAITraceSink()`.
 */

import {
  type AIGeneration,
  type AITrace,
  type AITraceQueryOptions,
  type AITraceSink,
  type AITraceStatus,
  type EndTraceParams,
  type RecordGenerationParams,
  redactContent,
  redactPromptMessages,
  type StartTraceParams,
} from "./ai-trace";

// ── In-memory store ──────────────────────────────────────

/**
 * In-memory ring-buffer `AITraceSink`. Generations are the primary bounded
 * collection; traces are bounded independently. Both trim the oldest half
 * when at capacity (matching `AIActionAuditStore`).
 */
export class InMemoryAITraceStore implements AITraceSink {
  private readonly generations: AIGeneration[] = [];
  private readonly traces = new Map<string, AITrace>();
  /** Insertion order of trace ids, for trim + most-recent-first queries. */
  private readonly traceOrder: string[] = [];
  private readonly maxGenerations: number;
  private readonly maxTraces: number;

  constructor(options?: { maxGenerations?: number; maxTraces?: number }) {
    const maxGenerations = options?.maxGenerations ?? 50_000;
    const maxTraces = options?.maxTraces ?? 50_000;
    if (!Number.isInteger(maxGenerations) || maxGenerations <= 0) {
      throw new RangeError("maxGenerations must be a positive integer");
    }
    if (!Number.isInteger(maxTraces) || maxTraces <= 0) {
      throw new RangeError("maxTraces must be a positive integer");
    }
    this.maxGenerations = maxGenerations;
    this.maxTraces = maxTraces;
  }

  startTrace(params: StartTraceParams): string {
    const traceId = params.traceId ?? crypto.randomUUID();
    if (this.traces.has(traceId)) {
      return traceId;
    }
    const trace: AITrace = Object.freeze({
      traceId,
      name: params.name,
      tenantId: params.tenantId,
      actorId: params.actorId,
      scenario: params.scenario,
      fixtureId: params.fixtureId,
      evalRunId: params.evalRunId,
      origin: params.origin ?? "production",
      tags: params.tags ? Object.freeze([...params.tags]) : undefined,
      metadata: params.metadata,
      startedAt: params.startedAt ?? Date.now(),
      endedAt: undefined,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      sampled: params.sampled ?? true,
      status: "ok",
    });
    this.insertTrace(trace);
    return traceId;
  }

  endTrace(params: EndTraceParams): void {
    const existing = this.traces.get(params.traceId);
    if (!existing) return;
    this.traces.set(
      params.traceId,
      Object.freeze({
        ...existing,
        endedAt: params.endedAt ?? Date.now(),
        status: params.status ?? existing.status,
      }),
    );
  }

  recordGeneration(params: RecordGenerationParams): AIGeneration {
    // Ensure a parent trace exists so aggregates have a home.
    let trace = this.traces.get(params.traceId);
    if (!trace) {
      this.startTrace({
        traceId: params.traceId,
        name: params.model,
        tenantId: params.tenantId,
      });
      trace = this.traces.get(params.traceId);
    }

    const generation: AIGeneration = Object.freeze({
      id: crypto.randomUUID(),
      traceId: params.traceId,
      model: params.model,
      provider: params.provider,
      messages: Object.freeze(redactPromptMessages(params.messages, params.redaction)),
      completion: redactContent(params.completion, params.redaction),
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cost: params.cost,
      latencyMs: params.latencyMs,
      temperature: params.temperature,
      responseFormat: params.responseFormat,
      fallbackUsed: params.fallbackUsed,
      cached: params.cached,
      partial: params.partial,
      status: params.status,
      error: params.error,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });

    // Trim oldest half when at capacity (mirror AIActionAuditStore).
    if (this.generations.length >= this.maxGenerations) {
      this.generations.splice(0, Math.max(1, this.generations.length >> 1));
    }
    this.generations.push(generation);

    // Roll up aggregate token / cost counters + escalate status on error.
    if (trace) {
      const status: AITraceStatus = params.status === "error" ? "error" : trace.status;
      this.traces.set(
        trace.traceId,
        Object.freeze({
          ...trace,
          inputTokens: trace.inputTokens + params.inputTokens,
          outputTokens: trace.outputTokens + params.outputTokens,
          cost: trace.cost + (params.cost ?? 0),
          status,
        }),
      );
    }

    return generation;
  }

  query(options?: AITraceQueryOptions): AIGeneration[] {
    let results = [...this.generations];

    if (options?.traceId) {
      results = results.filter((g) => g.traceId === options.traceId);
    }
    if (options?.model) {
      results = results.filter((g) => g.model === options.model);
    }
    if (options?.status) {
      results = results.filter((g) => g.status === options.status);
    }
    if (options?.tenantId) {
      results = results.filter((g) => this.traces.get(g.traceId)?.tenantId === options.tenantId);
    }
    if (options?.scenario) {
      results = results.filter((g) => this.traces.get(g.traceId)?.scenario === options.scenario);
    }
    if (options?.origin) {
      results = results.filter((g) => this.traces.get(g.traceId)?.origin === options.origin);
    }
    if (options?.after !== undefined) {
      const after = options.after;
      results = results.filter((g) => g.startedAt > after);
    }
    if (options?.before !== undefined) {
      const before = options.before;
      results = results.filter((g) => g.startedAt < before);
    }

    results.reverse(); // most recent first

    if (options?.limit !== undefined && options.limit >= 0) {
      results = results.slice(0, options.limit);
    }
    return results;
  }

  queryTraces(options?: AITraceQueryOptions): AITrace[] {
    let results = this.traceOrder
      .map((id) => this.traces.get(id))
      .filter((t): t is AITrace => t !== undefined);

    if (options?.traceId) {
      results = results.filter((t) => t.traceId === options.traceId);
    }
    if (options?.tenantId) {
      results = results.filter((t) => t.tenantId === options.tenantId);
    }
    if (options?.scenario) {
      results = results.filter((t) => t.scenario === options.scenario);
    }
    if (options?.origin) {
      results = results.filter((t) => t.origin === options.origin);
    }
    if (options?.status) {
      results = results.filter((t) => t.status === options.status);
    }
    if (options?.after !== undefined) {
      const after = options.after;
      results = results.filter((t) => t.startedAt > after);
    }
    if (options?.before !== undefined) {
      const before = options.before;
      results = results.filter((t) => t.startedAt < before);
    }

    results.reverse(); // most recent first

    if (options?.limit !== undefined && options.limit >= 0) {
      results = results.slice(0, options.limit);
    }
    return results;
  }

  get size(): number {
    return this.generations.length;
  }

  clear(): void {
    this.generations.length = 0;
    this.traces.clear();
    this.traceOrder.length = 0;
  }

  private insertTrace(trace: AITrace): void {
    if (this.traces.size >= this.maxTraces) {
      const drop = Math.max(1, this.traceOrder.length >> 1);
      const removed = this.traceOrder.splice(0, drop);
      for (const id of removed) {
        this.traces.delete(id);
      }
    }
    this.traces.set(trace.traceId, trace);
    this.traceOrder.push(trace.traceId);
  }
}

// ── Noop sink ────────────────────────────────────────────

/**
 * No-op `AITraceSink` — the registry default. `recordGeneration` returns a
 * cheap frozen record so callers that read the return value never crash, but
 * nothing is retained.
 */
export class NoopAITraceSink implements AITraceSink {
  startTrace(params: StartTraceParams): string {
    return params.traceId ?? crypto.randomUUID();
  }
  endTrace(_params: EndTraceParams): void {}
  recordGeneration(params: RecordGenerationParams): AIGeneration {
    return Object.freeze({
      id: crypto.randomUUID(),
      traceId: params.traceId,
      model: params.model,
      provider: params.provider,
      messages: Object.freeze([]),
      completion: "",
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cost: params.cost,
      latencyMs: params.latencyMs,
      temperature: params.temperature,
      responseFormat: params.responseFormat,
      fallbackUsed: params.fallbackUsed,
      cached: params.cached,
      partial: params.partial,
      status: params.status,
      error: params.error,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
  }
  query(_options?: AITraceQueryOptions): AIGeneration[] {
    return [];
  }
  queryTraces(_options?: AITraceQueryOptions): AITrace[] {
    return [];
  }
  get size(): number {
    return 0;
  }
  clear(): void {}
}

/** Shared singleton noop sink to avoid per-call allocation. */
export const noopAITraceSink: AITraceSink = new NoopAITraceSink();

// ── Module singleton registry ────────────────────────────

let currentSink: AITraceSink = noopAITraceSink;

/**
 * Get the active AI trace sink. Returns the noop sink until `setAITraceSink`
 * is called, so call sites never need to null-check.
 */
export function getAITraceSink(): AITraceSink {
  return currentSink;
}

/**
 * Register the active AI trace sink (e.g. an `InMemoryAITraceStore` wired in
 * at startup, or a fake in tests). Returns the previous sink so callers can
 * compose / restore.
 */
export function setAITraceSink(next: AITraceSink): AITraceSink {
  const prev = currentSink;
  currentSink = next;
  return prev;
}

/** Reset the sink registry to the noop default (test helper). */
export function resetAITraceSink(): AITraceSink {
  return setAITraceSink(noopAITraceSink);
}
