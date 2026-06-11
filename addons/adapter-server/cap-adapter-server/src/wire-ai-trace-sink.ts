/**
 * AI trace sink boot wiring (Spec 69 Phase 3 wave 2).
 *
 * The AI instrumentation (`ai-tracing.ts`) calls `getAITraceSink().recordGeneration(...)`
 * on EVERY AI call, but until a sink is registered via `setAITraceSink(...)` it writes
 * to the `NoopAITraceSink` default — every trace is discarded. This helper is the single
 * place the real server boot paths register a live sink so traces are actually persisted.
 *
 * Decision matrix:
 *  - A Postgres `db` handle is available (DB mode, `DATABASE_URL` set / DrizzleDataProvider
 *    in use) → register a `DrizzleAITraceStore`: durable PG mirror + a process-local hot view.
 *  - No db handle (InMemoryStore fallback, no `DATABASE_URL`) → register an
 *    `InMemoryAITraceStore` so traces are at least queryable in-process this run.
 *
 * Idempotent + non-throwing: a sink-wiring failure must NEVER crash boot. Any error is
 * caught and logged at WARN, leaving whatever sink was previously registered in place
 * (the noop default at worst). Tests that register their own sink are not fought — this
 * is only invoked from the real boot entrypoints (`dev.ts` + the http transport).
 */

import type { DataProvider, Logger } from "@linchkit/core";
import type { AITraceSink } from "@linchkit/core/server";
import {
  consoleLogger,
  getAITraceSink,
  InMemoryAITraceStore,
  NoopAITraceSink,
  setAITraceSink,
} from "@linchkit/core/server";

/**
 * Extract the underlying `PostgresJsDatabase` handle from a DataProvider when it
 * is a Drizzle-backed provider, reusing the SAME connection pool the data layer
 * already opened (never opening a second pool).
 *
 * The `db` field on `DrizzleDataProvider` is a TypeScript-private (not a runtime
 * `#private`), so a structural read works at runtime — the same access pattern
 * `http-transport.ts` already uses to hand the system data provider its db.
 * Returns `undefined` for `InMemoryStore` (or any provider without a db handle),
 * which is the signal to fall back to the in-memory trace sink.
 */
export function extractDbHandle(
  dataProvider: DataProvider | undefined,
): import("drizzle-orm/postgres-js").PostgresJsDatabase | undefined {
  const candidate = (dataProvider as { db?: unknown } | undefined)?.db;
  // A DrizzleDataProvider always carries a non-null db; InMemoryStore has none.
  if (candidate && typeof candidate === "object") {
    return candidate as import("drizzle-orm/postgres-js").PostgresJsDatabase;
  }
  return undefined;
}

/** Options for {@link wireAITraceSink}. */
export interface WireAITraceSinkOptions {
  /**
   * The boot DataProvider. When it is a Drizzle-backed provider its db handle is
   * reused for a durable `DrizzleAITraceStore`; otherwise an in-memory sink is wired.
   */
  dataProvider?: DataProvider;
  /** Logger for the wiring summary / failure. Defaults to `consoleLogger`. */
  logger?: Logger;
}

/**
 * Register the live AI trace sink for the running server.
 *
 * Returns the sink that was registered (for the boot summary / tests), or
 * `undefined` if wiring failed and the previous sink was left untouched. Safe to
 * call from any boot path: it never throws.
 *
 * Async because the `DrizzleAITraceStore` lives in `@linchkit/cap-ai-provider`,
 * loaded lazily so cap-adapter-server keeps only a dev/optional dependency on it
 * (mirrors how `dev.ts` lazy-imports `createAIService`). The in-memory fallback
 * needs no async work but the signature stays uniform for both branches.
 */
export async function wireAITraceSink(
  options: WireAITraceSinkOptions = {},
): Promise<AITraceSink | undefined> {
  const logger = options.logger ?? consoleLogger;
  try {
    // Idempotent: if a LIVE sink is already registered (anything other than the
    // Noop default — a prior wireAITraceSink call, or a test's own
    // setAITraceSink), leave it in place. Constructing a second sink would
    // orphan the first and drop its pending mirror writes.
    const existing = getAITraceSink();
    if (!(existing instanceof NoopAITraceSink)) {
      return existing;
    }
    const db = extractDbHandle(options.dataProvider);
    if (db) {
      // Lazy import so cap-adapter-server does not hard-load cap-ai-provider's
      // Drizzle store at module-init time (only needed in DB mode).
      const { DrizzleAITraceStore } = await import("@linchkit/cap-ai-provider");
      const sink = new DrizzleAITraceStore({ db, logger });
      setAITraceSink(sink);
      logger.info(
        "[ai-trace] persistence ON — traces mirrored to PostgreSQL (DrizzleAITraceStore)",
      );
      return sink;
    }

    // No Postgres handle — register the in-memory store so traces are at least
    // queryable in-process this run (vs the noop default which discards them).
    const sink = new InMemoryAITraceStore();
    setAITraceSink(sink);
    logger.info(
      "[ai-trace] persistence OFF (no DATABASE_URL) — traces retained in-memory only for this process (InMemoryAITraceStore)",
    );
    return sink;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      logger.warn(
        `[ai-trace] failed to wire trace sink (traces keep using the previous/noop sink): ${message}`,
      );
    } catch {
      // Logger itself failed — nothing more we can safely do; never crash boot.
    }
    return undefined;
  }
}
