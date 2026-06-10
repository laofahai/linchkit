/**
 * DrizzleAITraceStore — PostgreSQL-backed {@link AITraceSink} (Spec 69
 * Phase 3, issue #350).
 *
 * The core `AITraceSink` interface is SYNCHRONOUS (the instrumentation in
 * `ai-tracing.ts` calls `recordGeneration()` inline on the AI hot path), so
 * this store follows the same architecture as the watcher debounce-state
 * persistence (`watcher-state-persistence.ts`): an in-memory hot path plus a
 * durable PG mirror fed by serialized, fire-and-forget write-through.
 *
 *  - Synchronous interface methods (`startTrace` / `endTrace` /
 *    `recordGeneration` / `query` / `queryTraces` / `size` / `clear`) delegate
 *    to an embedded {@link InMemoryAITraceStore} — identical semantics,
 *    redaction and aggregation — and additionally enqueue a PG mirror write.
 *  - Mirror writes are serialized through a single tail promise so they apply
 *    in submission order, and every link swallows + logs its own error: a DB
 *    outage can NEVER throw into (or slow down) a real AI call.
 *  - Durable reads go through the async {@link queryPersisted} /
 *    {@link queryTracesPersisted}, which implement the exact filter semantics
 *    of `InMemoryAITraceStore.query` / `queryTraces` in SQL (strict time
 *    bounds, trace-level tenant/scenario/origin filters, most-recent-first by
 *    insertion order, `limit: 0` ⇒ empty / negative limit ⇒ uncapped).
 *  - {@link purgeOlderThan} implements retention (default 90 days). No
 *    background timer here — scheduling is a later wave; callers invoke it.
 *
 * After a process restart the in-memory hot view starts empty (sync `query`
 * sees only the current process); historical data is served by the persisted
 * query methods. All queries are parameterized via Drizzle's query builder.
 */

import type { Logger } from "@linchkit/core";
import type {
  AIGeneration,
  AITrace,
  AITraceQueryOptions,
  AITraceSink,
  EndTraceParams,
  RecordGenerationParams,
  StartTraceParams,
} from "@linchkit/core/server";
import { consoleLogger, InMemoryAITraceStore } from "@linchkit/core/server";
import { and, desc, eq, gt, lt, notExists, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { aiGenerationsTable, aiTracesTable } from "./ai-trace-tables";

/** Default retention window for {@link DrizzleAITraceStore.purgeOlderThan}. */
export const DEFAULT_TRACE_RETENTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

export interface DrizzleAITraceStoreOptions {
  db: PostgresJsDatabase;
  /** Runtime logger for mirror-write failures. Defaults to `consoleLogger`. */
  logger?: Logger;
  /** Hot-view capacity — forwarded to the embedded in-memory store. */
  maxGenerations?: number;
  /** Hot-view capacity — forwarded to the embedded in-memory store. */
  maxTraces?: number;
}

/** Map a `_linchkit.ai_generations` row to the domain {@link AIGeneration}. */
function rowToGeneration(row: typeof aiGenerationsTable.$inferSelect): AIGeneration {
  return Object.freeze({
    id: row.id,
    traceId: row.traceId,
    model: row.model,
    provider: row.provider,
    messages: Object.freeze(row.messages.map((m) => ({ role: m.role, content: m.content }))),
    completion: row.completion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    ...(row.cost !== null ? { cost: row.cost } : {}),
    latencyMs: row.latencyMs,
    ...(row.temperature !== null ? { temperature: row.temperature } : {}),
    ...(row.responseFormat !== null ? { responseFormat: row.responseFormat } : {}),
    ...(row.fallbackUsed !== null ? { fallbackUsed: row.fallbackUsed } : {}),
    ...(row.cached !== null ? { cached: row.cached } : {}),
    ...(row.partial !== null ? { partial: row.partial } : {}),
    status: row.status,
    ...(row.error !== null ? { error: row.error } : {}),
    startedAt: row.startedAt.getTime(),
    endedAt: row.endedAt.getTime(),
  });
}

/** Map a `_linchkit.ai_traces` row to the domain {@link AITrace}. */
function rowToTrace(row: typeof aiTracesTable.$inferSelect): AITrace {
  return Object.freeze({
    traceId: row.traceId,
    name: row.name,
    ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
    ...(row.actorId !== null ? { actorId: row.actorId } : {}),
    ...(row.scenario !== null ? { scenario: row.scenario } : {}),
    ...(row.fixtureId !== null ? { fixtureId: row.fixtureId } : {}),
    ...(row.evalRunId !== null ? { evalRunId: row.evalRunId } : {}),
    origin: row.origin,
    ...(row.tags !== null ? { tags: Object.freeze([...row.tags]) } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    startedAt: row.startedAt.getTime(),
    ...(row.endedAt !== null ? { endedAt: row.endedAt.getTime() } : {}),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
    sampled: row.sampled,
    status: row.status,
  });
}

export class DrizzleAITraceStore implements AITraceSink {
  private readonly db: PostgresJsDatabase;
  private readonly logger: Logger;
  /** Synchronous hot path — identical semantics to the pure in-memory sink. */
  private readonly memory: InMemoryAITraceStore;

  /**
   * Tail of the serialized mirror-write chain. Every PG write appends itself
   * here so writes land in submission order (a trace upsert always precedes
   * the generation insert that references it). Each link swallows + logs its
   * own failure so the chain never breaks and never rejects.
   */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: DrizzleAITraceStoreOptions) {
    this.db = options.db;
    this.logger = options.logger ?? consoleLogger;
    this.memory = new InMemoryAITraceStore({
      maxGenerations: options.maxGenerations,
      maxTraces: options.maxTraces,
    });
  }

  // ── Synchronous AITraceSink interface ──────────────────

  startTrace(params: StartTraceParams): string {
    // Resolve defaults ONCE so the memory record and the PG row are identical.
    const resolved: StartTraceParams = {
      ...params,
      traceId: params.traceId ?? crypto.randomUUID(),
      origin: params.origin ?? "production",
      startedAt: params.startedAt ?? Date.now(),
      sampled: params.sampled ?? true,
    };
    const traceId = this.memory.startTrace(resolved);
    this.enqueue("startTrace", async () => {
      // `onConflictDoNothing` mirrors the in-memory "already open ⇒ keep" rule.
      await this.db
        .insert(aiTracesTable)
        .values(this.traceRow(resolved))
        .onConflictDoNothing({ target: aiTracesTable.traceId });
    });
    return traceId;
  }

  endTrace(params: EndTraceParams): void {
    const endedAt = params.endedAt ?? Date.now();
    this.memory.endTrace({ ...params, endedAt });
    this.enqueue("endTrace", async () => {
      // Unknown traceId ⇒ 0 rows updated — same no-op as the in-memory store.
      await this.db
        .update(aiTracesTable)
        .set({
          endedAt: new Date(endedAt),
          ...(params.status !== undefined ? { status: params.status } : {}),
        })
        .where(eq(aiTracesTable.traceId, params.traceId));
    });
  }

  recordGeneration(params: RecordGenerationParams): AIGeneration {
    // The in-memory store applies redaction + aggregation and auto-opens the
    // parent trace; persist the returned (already-redacted) record verbatim
    // so redaction happens exactly once.
    const generation = this.memory.recordGeneration(params);
    const parentRow = this.parentTraceRowFor(generation, params);
    this.enqueue("recordGeneration", async () => {
      await this.db
        .insert(aiTracesTable)
        .values(parentRow)
        .onConflictDoNothing({ target: aiTracesTable.traceId });
      await this.db.insert(aiGenerationsTable).values({
        id: generation.id,
        traceId: generation.traceId,
        model: generation.model,
        provider: generation.provider,
        messages: generation.messages,
        completion: generation.completion,
        inputTokens: generation.inputTokens,
        outputTokens: generation.outputTokens,
        cost: generation.cost ?? null,
        latencyMs: generation.latencyMs,
        temperature: generation.temperature ?? null,
        responseFormat: generation.responseFormat ?? null,
        fallbackUsed: generation.fallbackUsed ?? null,
        cached: generation.cached ?? null,
        partial: generation.partial ?? null,
        status: generation.status,
        error: generation.error ?? null,
        startedAt: new Date(generation.startedAt),
        endedAt: new Date(generation.endedAt),
      });
      // Aggregate rollup as SQL increments — durable + restart-safe (matches
      // the in-memory rollup, including the status escalation on error).
      await this.db
        .update(aiTracesTable)
        .set({
          inputTokens: sql`${aiTracesTable.inputTokens} + ${generation.inputTokens}`,
          outputTokens: sql`${aiTracesTable.outputTokens} + ${generation.outputTokens}`,
          cost: sql`${aiTracesTable.cost} + ${generation.cost ?? 0}`,
          ...(generation.status === "error" ? { status: "error" as const } : {}),
        })
        .where(eq(aiTracesTable.traceId, generation.traceId));
    });
    return generation;
  }

  /** Synchronous hot view — generations recorded by THIS process only. */
  query(options?: AITraceQueryOptions): AIGeneration[] {
    return this.memory.query(options);
  }

  /** Synchronous hot view — traces recorded by THIS process only. */
  queryTraces(options?: AITraceQueryOptions): AITrace[] {
    return this.memory.queryTraces(options);
  }

  /** Hot-view generation count (process-local; durable count lives in PG). */
  get size(): number {
    return this.memory.size;
  }

  /** Clear hot view + enqueue a mirror wipe (test helper, like the peers). */
  clear(): void {
    this.memory.clear();
    this.enqueue("clear", async () => {
      await this.db.delete(aiGenerationsTable);
      await this.db.delete(aiTracesTable);
    });
  }

  // ── Durable (async) reads ──────────────────────────────

  /**
   * Query persisted generations — same filter semantics as
   * `InMemoryAITraceStore.query`: most-recent-first (insertion order), strict
   * `after`/`before` bounds on `startedAt`, tenant/scenario/origin resolved
   * via the parent trace (a generation whose parent is missing is excluded by
   * those filters), `limit: 0` ⇒ empty, negative limit ⇒ uncapped.
   */
  async queryPersisted(options?: AITraceQueryOptions): Promise<AIGeneration[]> {
    const limit = options?.limit;
    const hasLimit = limit !== undefined && limit >= 0;
    if (hasLimit && limit === 0) return [];

    const conditions: SQL[] = [];
    if (options?.traceId) conditions.push(eq(aiGenerationsTable.traceId, options.traceId));
    if (options?.model) conditions.push(eq(aiGenerationsTable.model, options.model));
    if (options?.status) conditions.push(eq(aiGenerationsTable.status, options.status));
    if (options?.after !== undefined)
      conditions.push(gt(aiGenerationsTable.startedAt, new Date(options.after)));
    if (options?.before !== undefined)
      conditions.push(lt(aiGenerationsTable.startedAt, new Date(options.before)));
    // Trace-level filters: the LEFT JOIN row is NULL for an orphan generation,
    // so an equality condition on a trace column excludes it — identical to
    // the in-memory `trace?.tenantId !== options.tenantId` check.
    if (options?.tenantId) conditions.push(eq(aiTracesTable.tenantId, options.tenantId));
    if (options?.scenario) conditions.push(eq(aiTracesTable.scenario, options.scenario));
    if (options?.origin) conditions.push(eq(aiTracesTable.origin, options.origin));

    const base = this.db
      .select({ gen: aiGenerationsTable })
      .from(aiGenerationsTable)
      .leftJoin(aiTracesTable, eq(aiGenerationsTable.traceId, aiTracesTable.traceId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiGenerationsTable.seq));
    const rows = hasLimit ? await base.limit(limit) : await base;
    return rows.map((r) => rowToGeneration(r.gen));
  }

  /**
   * Query persisted traces — same filter semantics as
   * `InMemoryAITraceStore.queryTraces` (see {@link queryPersisted}).
   */
  async queryTracesPersisted(options?: AITraceQueryOptions): Promise<AITrace[]> {
    const limit = options?.limit;
    const hasLimit = limit !== undefined && limit >= 0;
    if (hasLimit && limit === 0) return [];

    const conditions: SQL[] = [];
    if (options?.traceId) conditions.push(eq(aiTracesTable.traceId, options.traceId));
    if (options?.tenantId) conditions.push(eq(aiTracesTable.tenantId, options.tenantId));
    if (options?.scenario) conditions.push(eq(aiTracesTable.scenario, options.scenario));
    if (options?.origin) conditions.push(eq(aiTracesTable.origin, options.origin));
    if (options?.status) conditions.push(eq(aiTracesTable.status, options.status));
    if (options?.after !== undefined)
      conditions.push(gt(aiTracesTable.startedAt, new Date(options.after)));
    if (options?.before !== undefined)
      conditions.push(lt(aiTracesTable.startedAt, new Date(options.before)));

    const base = this.db
      .select()
      .from(aiTracesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiTracesTable.seq));
    const rows = hasLimit ? await base.limit(limit) : await base;
    return rows.map(rowToTrace);
  }

  // ── Retention ──────────────────────────────────────────

  /**
   * Delete persisted generations older than `days` (by `started_at`), then
   * traces older than the same cutoff that no longer have any generations.
   * Returns deleted row counts. Propagates DB errors — this runs on a
   * maintenance path (manual / scheduled), never on the AI call path. No
   * background timer is wired here; scheduling is a later wave.
   */
  async purgeOlderThan(
    days: number = DEFAULT_TRACE_RETENTION_DAYS,
  ): Promise<{ generations: number; traces: number }> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new RangeError("purgeOlderThan(days) requires a positive number of days");
    }
    // Drain pending mirror writes so the purge sees a consistent snapshot.
    await this.whenPersisted();
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);
    const generations = await this.db
      .delete(aiGenerationsTable)
      .where(lt(aiGenerationsTable.startedAt, cutoff))
      .returning({ id: aiGenerationsTable.id });
    const traces = await this.db
      .delete(aiTracesTable)
      .where(
        and(
          lt(aiTracesTable.startedAt, cutoff),
          // Keep an old trace alive while any (newer) generation references it.
          notExists(
            this.db
              .select({ one: sql<number>`1` })
              .from(aiGenerationsTable)
              .where(eq(aiGenerationsTable.traceId, aiTracesTable.traceId)),
          ),
        ),
      )
      .returning({ traceId: aiTracesTable.traceId });
    return { generations: generations.length, traces: traces.length };
  }

  // ── Mirror plumbing ────────────────────────────────────

  /**
   * Resolve once every pending mirror write submitted so far has settled
   * (applied or logged-and-skipped). Never rejects. For tests + shutdown.
   */
  async whenPersisted(): Promise<void> {
    await this.writeTail;
  }

  /**
   * Append a mirror write to the serialized tail. The op's failure (sync
   * throw or async rejection) is logged and swallowed so the chain — and the
   * AI call path above it — keeps going.
   */
  private enqueue(stage: string, op: () => Promise<void>): void {
    this.writeTail = this.writeTail.then(op).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        this.logger.warn(`[ai-trace-store] ${stage} mirror write failed (skipped): ${message}`);
      } catch {
        // Logger itself failed — nothing more we can safely do.
      }
    });
  }

  /** Build a full `ai_traces` insert row from resolved start params. */
  private traceRow(resolved: StartTraceParams): typeof aiTracesTable.$inferInsert {
    return {
      // `startTrace` resolves these before calling; the fallbacks only guard
      // the type system (StartTraceParams keeps them optional).
      traceId: resolved.traceId ?? crypto.randomUUID(),
      name: resolved.name,
      tenantId: resolved.tenantId ?? null,
      actorId: resolved.actorId ?? null,
      scenario: resolved.scenario ?? null,
      fixtureId: resolved.fixtureId ?? null,
      evalRunId: resolved.evalRunId ?? null,
      origin: resolved.origin ?? "production",
      tags: resolved.tags ? [...resolved.tags] : null,
      metadata: resolved.metadata ?? null,
      startedAt: new Date(resolved.startedAt ?? Date.now()),
      endedAt: null,
      // Aggregates always start at zero — recordGeneration's increment-update
      // is the single place rollups happen, so first-insert never double-counts.
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      sampled: resolved.sampled ?? true,
      status: "ok",
    };
  }

  /**
   * Snapshot the parent-trace row to upsert alongside a generation insert.
   * The in-memory store just created/loaded the parent, so mirror ITS
   * non-aggregate fields (covers the auto-open path where `startTrace` was
   * never called). Falls back to a minimal row derived from the generation if
   * the hot view already trimmed the trace (extreme churn).
   */
  private parentTraceRowFor(
    generation: AIGeneration,
    params: RecordGenerationParams,
  ): typeof aiTracesTable.$inferInsert {
    const snapshot = this.memory.queryTraces({ traceId: generation.traceId, limit: 1 })[0];
    if (snapshot) {
      return this.traceRow({
        traceId: snapshot.traceId,
        name: snapshot.name,
        tenantId: snapshot.tenantId,
        actorId: snapshot.actorId,
        scenario: snapshot.scenario,
        fixtureId: snapshot.fixtureId,
        evalRunId: snapshot.evalRunId,
        origin: snapshot.origin,
        tags: snapshot.tags,
        metadata: snapshot.metadata,
        startedAt: snapshot.startedAt,
        sampled: snapshot.sampled,
      });
    }
    return this.traceRow({
      traceId: generation.traceId,
      name: params.model,
      tenantId: params.tenantId,
      startedAt: generation.startedAt,
    });
  }
}
