/**
 * Boot-wiring test for the AI trace sink (Spec 69 P3 wave 2).
 *
 * Proves the helper the real boot paths (`dev.ts` + `http-transport.ts`) call:
 *   - with NO db handle (InMemoryStore / no DATABASE_URL) → the active sink is an
 *     `InMemoryAITraceStore`, NOT the discarding `NoopAITraceSink` default,
 *   - with a Drizzle-backed provider (DATABASE_URL set) → the active sink is a
 *     `DrizzleAITraceStore` so traces are durably mirrored to PostgreSQL,
 *   - `extractDbHandle` reuses the provider's existing db handle (no second pool),
 *   - wiring is non-throwing: a provider that explodes on `.db` access leaves the
 *     previous sink in place rather than crashing boot.
 *
 * The DB-mode assertion is gated on a reachable PostgreSQL (skips gracefully in CI
 * without PG, RUNS where the `postgres` service is provided), mirroring the
 * established DrizzleAITraceStore integration-test idiom.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { DrizzleAITraceStore } from "@linchkit/cap-ai-provider";
import {
  closeDatabase,
  createDatabase,
  DrizzleDataProvider,
  getAITraceSink,
  InMemoryAITraceStore,
  InMemoryStore,
  NoopAITraceSink,
  resetAITraceSink,
  TableRegistry,
} from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import { extractDbHandle, wireAITraceSink } from "../src/wire-ai-trace-sink";

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await closeDatabase();
    } catch {
      // Ignore — probe pool may already be closed.
    }
  }
}

const dbAvailable = await canConnect();
if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping wire-ai-trace-sink DB-mode test");
}

describe("wireAITraceSink — boot wiring", () => {
  afterEach(() => {
    resetAITraceSink();
  });

  it("no db handle → registers InMemoryAITraceStore (not the Noop default)", async () => {
    // Default sink is Noop until wired — assert the wiring flips it.
    resetAITraceSink();
    expect(getAITraceSink()).toBeInstanceOf(NoopAITraceSink);

    const sink = await wireAITraceSink({ dataProvider: new InMemoryStore() });

    expect(sink).toBeInstanceOf(InMemoryAITraceStore);
    expect(getAITraceSink()).toBeInstanceOf(InMemoryAITraceStore);
    expect(getAITraceSink()).not.toBeInstanceOf(NoopAITraceSink);
  });

  it("no provider at all → still registers InMemoryAITraceStore", async () => {
    const sink = await wireAITraceSink();
    expect(sink).toBeInstanceOf(InMemoryAITraceStore);
    expect(getAITraceSink()).toBeInstanceOf(InMemoryAITraceStore);
  });

  it("never throws and leaves the prior (noop) sink when the provider .db access explodes", async () => {
    // From the Noop default, a provider whose `db` getter throws must be
    // swallowed — boot never crashes and the sink is left as-is.
    resetAITraceSink();
    expect(getAITraceSink()).toBeInstanceOf(NoopAITraceSink);

    const explodingProvider = {
      get db() {
        throw new Error("boom");
      },
    } as unknown as InMemoryStore;

    // extractDbHandle reads `.db` inside the try, so the throw is caught and the
    // prior (noop) sink is preserved.
    const result = await wireAITraceSink({ dataProvider: explodingProvider });
    expect(result).toBeUndefined();
    expect(getAITraceSink()).toBeInstanceOf(NoopAITraceSink);
  });

  it("is idempotent — a second call returns the already-wired sink, not a new one", async () => {
    resetAITraceSink();
    const first = await wireAITraceSink({ dataProvider: new InMemoryStore() });
    expect(first).toBeInstanceOf(InMemoryAITraceStore);
    // A second call must NOT construct a second sink (which would orphan the
    // first and drop its pending mirror writes) — it returns the existing one.
    const second = await wireAITraceSink({ dataProvider: new InMemoryStore() });
    expect(second).toBe(first);
    expect(getAITraceSink()).toBe(first);
  });

  it("extractDbHandle returns undefined for InMemoryStore", () => {
    expect(extractDbHandle(new InMemoryStore())).toBeUndefined();
    expect(extractDbHandle(undefined)).toBeUndefined();
  });

  it.skipIf(!dbAvailable)(
    "db handle present → registers DrizzleAITraceStore (durable PG mirror)",
    async () => {
      const db = createDatabase({ url: DATABASE_URL });
      const provider = new DrizzleDataProvider(db, new TableRegistry());

      // extractDbHandle reuses the SAME db object the provider holds (no 2nd pool).
      expect(extractDbHandle(provider)).toBe(db);

      const sink = await wireAITraceSink({ dataProvider: provider });

      expect(sink).toBeInstanceOf(DrizzleAITraceStore);
      expect(getAITraceSink()).toBeInstanceOf(DrizzleAITraceStore);
      expect(getAITraceSink()).not.toBeInstanceOf(NoopAITraceSink);

      await closeDatabase();
    },
  );
});
