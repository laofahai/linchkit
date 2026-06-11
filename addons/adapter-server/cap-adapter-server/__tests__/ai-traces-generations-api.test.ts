/**
 * AI trace generation drill-down tests — GET /api/ai/traces/:id/generations
 * (issue #350, content drill-down).
 *
 * Pins the per-call read side of trace persistence:
 *   - generations under one parent trace are surfaced (most-recent-first),
 *   - an unknown trace id returns an empty list (not a 404),
 *   - query-param validation rejects an empty :id and a bad ?limit=,
 *   - the CommandLayer permission slot is NEVER skipped: a denying layer 403s
 *     with the canonical AUTHZ_DENIED envelope and the sink is not consulted,
 *   - the tenant slot's resolved tenantId scopes the query (a scoped operator
 *     cannot read another tenant's generations).
 *
 * Endpoint dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite SEGFAULTS
 * the batched addons run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandLayer } from "@linchkit/core";
import {
  getAITraceSink,
  InMemoryAITraceStore,
  resetAITraceSink,
  setAITraceSink,
} from "@linchkit/core/server";
import { Elysia } from "elysia";
import { mountAITracesRoutes } from "../src/routes/ai-traces-api";
import type { ServerOptions } from "../src/server";

const BASE = "http://local.test";

interface GenerationsJson {
  success: boolean;
  data?: {
    generations?: Array<{ id: string; traceId: string; model: string }>;
    count?: number;
  };
  error?: { code?: string; message?: string };
}

/** Permissive command layer; `data` carries the synthetic tenant slot result. */
function passLayer(data: Record<string, unknown> = {}): CommandLayer {
  return { execute: async () => ({ success: true, data }) } as unknown as CommandLayer;
}

/**
 * Denying command layer — mirrors the REAL permission-slot rejection shape:
 * createPermissionMiddleware throws AuthorizationError({ code:"authz.action.denied" }),
 * which CommandLayer propagates as `{ success:false, data:{ code:"authz.action.denied" } }`.
 */
function denyLayer(): CommandLayer {
  return {
    execute: async () => ({
      success: false,
      data: { code: "authz.action.denied", error: "not allowed" },
    }),
  } as unknown as CommandLayer;
}

/** Records each dispatch so we can prove the sink is NOT consulted when denied. */
function spyLayer(): { layer: CommandLayer; calls: number } {
  const state = { calls: 0 };
  const layer = {
    execute: async () => {
      state.calls += 1;
      return {
        success: false as const,
        data: { code: "authz.action.denied", error: "not allowed" },
      };
    },
  } as unknown as CommandLayer;
  return {
    layer,
    get calls() {
      return state.calls;
    },
  };
}

/**
 * Replace the active sink's READ methods with traps that count + throw, so a
 * denied request that wrongly consulted the sink is provable: queryCalls would
 * be > 0 AND the response would become 500 (the throw) instead of the asserted
 * 403. Proves the permission slot gates BEFORE any sink access.
 */
function trapSinkQueries(): { queryCalls: number } {
  const sink = getAITraceSink() as unknown as {
    query: (...a: unknown[]) => unknown;
    queryPersisted?: (...a: unknown[]) => unknown;
  };
  const state = { queryCalls: 0 };
  sink.query = () => {
    state.queryCalls += 1;
    throw new Error("sink.query must not be reached on a denied request");
  };
  sink.queryPersisted = () => {
    state.queryCalls += 1;
    throw new Error("sink.queryPersisted must not be reached on a denied request");
  };
  return state;
}

function mountApp(opts: { commandLayer?: CommandLayer }): Elysia {
  const app = new Elysia();
  mountAITracesRoutes(app, { commandLayer: opts.commandLayer } as unknown as ServerOptions);
  return app;
}

async function getGenerations(
  app: Elysia,
  traceId: string,
  qs = "",
): Promise<{ status: number; json: GenerationsJson }> {
  const res = await app.handle(new Request(`${BASE}/api/ai/traces/${traceId}/generations${qs}`));
  return { status: res.status, json: (await res.json()) as GenerationsJson };
}

/** Seed a single generation under the given trace id. */
function seedGeneration(opts: { traceId: string; tenantId?: string; model?: string }): void {
  const sink = getAITraceSink();
  const now = Date.now();
  sink.startTrace({ traceId: opts.traceId, name: opts.model ?? "fast", tenantId: opts.tenantId });
  sink.recordGeneration({
    traceId: opts.traceId,
    model: opts.model ?? "fast",
    provider: "test",
    messages: [{ role: "user", content: "hi" }],
    completion: "hello",
    inputTokens: 3,
    outputTokens: 5,
    latencyMs: 12,
    status: "ok",
    startedAt: now,
    endedAt: now + 12,
    tenantId: opts.tenantId,
    redaction: { mode: "none" },
  });
}

describe("GET /api/ai/traces/:id/generations", () => {
  beforeEach(() => {
    // Fresh in-memory sink per test so seeded data doesn't leak across cases or
    // across the batched addons run (which shares the module singleton).
    setAITraceSink(new InMemoryAITraceStore());
  });

  afterEach(() => {
    resetAITraceSink();
  });

  test("returns only the generations under the requested trace", async () => {
    // 2 generations under t1, 1 under t2 — the drill-down for t1 must return
    // exactly the 2 t1 generations and never the t2 one.
    seedGeneration({ traceId: "t1" });
    seedGeneration({ traceId: "t1" });
    seedGeneration({ traceId: "t2" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getGenerations(app, "t1");

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.count).toBe(2);
    expect(json.data?.generations?.every((g) => g.traceId === "t1")).toBe(true);
  });

  test("returns an empty list for an unknown trace id (not a 404)", async () => {
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getGenerations(app, "does-not-exist");

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.generations).toEqual([]);
    expect(json.data?.count).toBe(0);
  });

  test("honours ?limit= (caps the result set)", async () => {
    seedGeneration({ traceId: "t1" });
    seedGeneration({ traceId: "t1" });
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getGenerations(app, "t1", "?limit=2");

    expect(status).toBe(200);
    expect(json.data?.count).toBe(2);
  });

  test("rejects an invalid ?limit= with 400", async () => {
    const app = mountApp({ commandLayer: passLayer() });
    const { status, json } = await getGenerations(app, "t1", "?limit=-1");
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("rejects ?limit=0 with 400 (must be positive, never silently zero rows)", async () => {
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: passLayer() });
    const { status, json } = await getGenerations(app, "t1", "?limit=0");
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("treats an empty ?limit= as 'use the default' (not 0)", async () => {
    seedGeneration({ traceId: "t1" });
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getGenerations(app, "t1", "?limit=");

    expect(status).toBe(200);
    expect(json.data?.count).toBe(2);
  });

  test("command layer absent → 503 (cannot authorize, fail closed)", async () => {
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: undefined });
    const { status, json } = await getGenerations(app, "t1");
    expect(status).toBe(503);
    expect(json.success).toBe(false);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; sink NOT consulted", async () => {
    seedGeneration({ traceId: "secret" });
    const trap = trapSinkQueries();
    const spy = spyLayer();
    const app = mountApp({ commandLayer: spy.layer });

    const { status, json } = await getGenerations(app, "secret");

    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    // No generation data leaked in the denied response.
    expect(json.data).toBeUndefined();
    // Permission slot ran (and denied) — exactly one dispatch.
    expect(spy.calls).toBe(1);
    // The sink's read methods were never reached on the denied path (a query
    // would have counted here AND turned the 403 into a 500 via the trap throw).
    expect(trap.queryCalls).toBe(0);
  });

  test("denying layer just blocks (separate denyLayer helper) → 403", async () => {
    seedGeneration({ traceId: "t1" });
    const app = mountApp({ commandLayer: denyLayer() });
    const { status, json } = await getGenerations(app, "t1");
    expect(status).toBe(403);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
  });

  test("tenant slot's resolved tenantId scopes the query (no cross-tenant read)", async () => {
    // Same trace id used across two tenants would be unusual, so use distinct
    // ids; the scope filter must exclude the foreign-tenant generation even when
    // the :id is asked for explicitly.
    seedGeneration({ traceId: "shared-a", tenantId: "tenant-a" });
    seedGeneration({ traceId: "shared-b", tenantId: "tenant-b" });
    // The tenant slot pinned tenant-a; a scoped operator must see only tenant-a's.
    const app = mountApp({ commandLayer: passLayer({ tenantId: "tenant-a" }) });

    // Asking for tenant-b's trace under a tenant-a-scoped actor → no rows.
    const denied = await getGenerations(app, "shared-b");
    expect(denied.status).toBe(200);
    expect(denied.json.data?.count).toBe(0);

    // Asking for tenant-a's own trace → the row is returned.
    const allowed = await getGenerations(app, "shared-a");
    expect(allowed.status).toBe(200);
    expect(allowed.json.data?.count).toBe(1);
    expect(allowed.json.data?.generations?.[0]?.traceId).toBe("shared-a");
  });

  test("unscoped (admin) caller sees generations across tenants", async () => {
    seedGeneration({ traceId: "ua", tenantId: "tenant-a" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getGenerations(app, "ua");

    expect(status).toBe(200);
    expect(json.data?.count).toBe(1);
  });
});
