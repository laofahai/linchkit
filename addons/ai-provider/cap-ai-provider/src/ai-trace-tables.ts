/**
 * AI trace system tables (Spec 69 Phase 3 — durable PG sink, issue #350).
 *
 * Drizzle schema for `_linchkit.ai_traces` + `_linchkit.ai_generations`.
 * Persists the `AITrace` / `AIGeneration` records emitted through the core
 * `AITraceSink` seam so traces survive process restarts and become queryable
 * across deploys (the in-memory ring buffer is process-local).
 *
 * Follows the `_linchkit` system-schema convention used by the other
 * addon-owned system tables (`_linchkit.watcher_state` in
 * `./watcher-state-table.ts`, `_linchkit.mcp_clients` in
 * `addons/adapter-mcp/cap-adapter-mcp/src/system-tables.ts`,
 * `_linchkit.search_documents` in `addons/search/cap-search/src/tables.ts`).
 * All DDL is delegated to drizzle-kit — these declarations are the single
 * source of truth. Like those peers, the tables are provisioned via `db:push`,
 * NOT the core migration chain (`drizzle/migrations/` is core-schema only).
 *
 * Column shapes mirror the authoritative model in
 * `packages/core/src/observability/ai-trace.ts`. Epoch-ms numbers on the
 * domain model map to `timestamp` columns (`mode: "date"` round-trips
 * millisecond precision exactly — PG `timestamp` carries microseconds).
 * `seq` is a storage-only bigserial that preserves insertion order so
 * most-recent-first queries match the in-memory store's ordering semantics
 * (insertion order, not `started_at` order).
 */

import type { AITraceMessage, AITraceOrigin, AITraceStatus } from "@linchkit/core/server";
import { linchkitSchema } from "@linchkit/core/server";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Parent traces — `_linchkit.ai_traces`.
 *
 * One row per `AITrace`. Aggregate token / cost counters are maintained by
 * `DrizzleAITraceStore` via SQL increments as child generations are recorded.
 * No FK to `ai_generations` — generations may auto-open their parent trace
 * and the two mirrors stay loosely coupled (matching the in-memory store).
 */
export const aiTracesTable = linchkitSchema.table(
  "ai_traces",
  {
    /** Unique trace id (UUID string allocated by the sink or the caller). */
    traceId: text("trace_id").primaryKey(),
    /** Insertion-order marker — most-recent-first queries order by this. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** Human-readable trace name (e.g. "intent"). */
    name: text("name").notNull(),
    /** Tenant id for isolation (null = tenant-less). */
    tenantId: text("tenant_id"),
    /** Acting user / agent id. */
    actorId: text("actor_id"),
    /** Scenario label (eval framework: scenario name). */
    scenario: text("scenario"),
    /** Fixture id when replaying a recorded fixture. */
    fixtureId: text("fixture_id"),
    /** Eval-run id grouping a batch of fixtures. */
    evalRunId: text("eval_run_id"),
    /** Origin — production vs eval. */
    origin: text("origin").$type<AITraceOrigin>().notNull(),
    /** Free-form tags for filtering. */
    tags: jsonb("tags").$type<readonly string[]>(),
    /** Additional structured metadata. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** When the trace started. */
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    /** When the trace ended (null while open). */
    endedAt: timestamp("ended_at", { mode: "date" }),
    /** Aggregate input tokens across all generations. */
    inputTokens: integer("input_tokens").notNull().default(0),
    /** Aggregate output tokens across all generations. */
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Aggregate estimated cost in USD across all generations. */
    cost: doublePrecision("cost").notNull().default(0),
    /** Whether this trace was sampled in (recorded). */
    sampled: boolean("sampled").notNull().default(true),
    /** Overall trace status ("ok" | "error" | "partial"). */
    status: text("status").$type<AITraceStatus>().notNull().default("ok"),
  },
  (table) => [index("idx_ai_traces_tenant_started").on(table.tenantId, table.startedAt)],
);

/**
 * Child generations — `_linchkit.ai_generations`.
 *
 * One row per `AIGeneration` (a single provider round-trip). Prompt messages
 * and completion are persisted ALREADY redacted — redaction happens once at
 * record time in the sink (see `RecordGenerationParams` contract).
 */
export const aiGenerationsTable = linchkitSchema.table(
  "ai_generations",
  {
    /** Unique generation id (UUID string). */
    id: text("id").primaryKey(),
    /** Insertion-order marker — most-recent-first queries order by this. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** Parent trace id this generation belongs to. */
    traceId: text("trace_id").notNull(),
    /** Resolved model id used. */
    model: text("model").notNull(),
    /** Provider name used. */
    provider: text("provider").notNull(),
    /** Redacted prompt messages (`{role, content}` array). */
    messages: jsonb("messages").$type<readonly AITraceMessage[]>().notNull(),
    /** Redacted completion text. */
    completion: text("completion").notNull(),
    /** Prompt tokens consumed. */
    inputTokens: integer("input_tokens").notNull(),
    /** Completion tokens produced. */
    outputTokens: integer("output_tokens").notNull(),
    /** Estimated cost in USD (null when pricing unavailable). */
    cost: doublePrecision("cost"),
    /** Wall-clock latency in milliseconds. */
    latencyMs: doublePrecision("latency_ms").notNull(),
    /** Sampling temperature, when supplied by the caller. */
    temperature: doublePrecision("temperature"),
    /** Response format requested ("text" | "json"). */
    responseFormat: text("response_format").$type<"text" | "json">(),
    /** Provider that originally failed, when a fallback served this one. */
    fallbackUsed: text("fallback_used"),
    /** Whether the result was served from cache. */
    cached: boolean("cached"),
    /** Whether this is a partial record (e.g. streaming, usage unknown). */
    partial: boolean("partial"),
    /** Generation status ("ok" | "error" | "partial"). */
    status: text("status").$type<AITraceStatus>().notNull(),
    /** Error message when status is "error" (caller-redacted, stored verbatim). */
    error: text("error"),
    /** When this generation started. */
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    /** When this generation ended. */
    endedAt: timestamp("ended_at", { mode: "date" }).notNull(),
  },
  (table) => [
    index("idx_ai_generations_trace_id").on(table.traceId),
    // Retention purges + time-window queries scan by start time.
    index("idx_ai_generations_started_at").on(table.startedAt),
  ],
);
