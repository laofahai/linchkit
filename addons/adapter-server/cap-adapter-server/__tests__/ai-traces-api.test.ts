/**
 * AI trace read endpoint tests — GET /api/ai/traces (Spec 69 P3 wave 2).
 *
 * Pins the read side of the trace persistence wired at boot:
 *   - traces seeded into the active sink are surfaced (most-recent-first),
 *   - `?limit=` is honoured + capped,
 *   - query-param validation rejects bad limit/origin/status,
 *   - the CommandLayer permission slot is NEVER skipped: a denying layer 403s
 *     with the canonical AUTHZ_DENIED envelope and the sink is not consulted,
 *   - the tenant slot's resolved tenantId scopes the query (a scoped operator
 *     cannot read across tenants).
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

interface TracesJson {
  success: boolean;
  data?: { traces?: Array<{ traceId: string; tenantId?: string }>; count?: number };
  error?: { code?: string; message?: string };
}

/** Permissive command layer; `data` carries the synthetic tenant slot result. */
function passLayer(data: Record<string, unknown> = {}): CommandLayer {
  return { execute: async () => ({ success: true, data }) } as unknown as CommandLayer;
}

/** Denying command layer — simulates the permission slot rejecting the caller. */
function denyLayer(): CommandLayer {
  return {
    execute: async () => ({ success: false, data: { error: "not allowed" } }),
  } as unknown as CommandLayer;
}

/** Records each dispatch so we can prove the sink is NOT consulted when denied. */
function spyLayer(): { layer: CommandLayer; calls: number } {
  const state = { calls: 0 };
  const layer = {
    execute: async () => {
      state.calls += 1;
      return { success: false as const, data: { error: "not allowed" } };
    },
  } as unknown as CommandLayer;
  return {
    layer,
    get calls() {
      return state.calls;
    },
  };
}

function mountApp(opts: { commandLayer?: CommandLayer }): Elysia {
  const app = new Elysia();
  mountAITracesRoutes(app, { commandLayer: opts.commandLayer } as unknown as ServerOptions);
  return app;
}

async function getTraces(app: Elysia, qs = ""): Promise<{ status: number; json: TracesJson }> {
  const res = await app.handle(new Request(`${BASE}/api/ai/traces${qs}`));
  return { status: res.status, json: (await res.json()) as TracesJson };
}

/** Seed a trace + a single generation so the parent trace exists in the sink. */
function seedTrace(opts: { traceId: string; tenantId?: string; model?: string }): void {
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

describe("GET /api/ai/traces", () => {
  beforeEach(() => {
    // Fresh in-memory sink per test so seeded traces don't leak across cases or
    // across the batched addons run (which shares the module singleton).
    setAITraceSink(new InMemoryAITraceStore());
  });

  afterEach(() => {
    resetAITraceSink();
  });

  test("returns seeded traces, most-recent-first, with a count", async () => {
    seedTrace({ traceId: "t1" });
    seedTrace({ traceId: "t2" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getTraces(app);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.count).toBe(2);
    // Most-recent-first: t2 was seeded last → it is first.
    expect(json.data?.traces?.map((t) => t.traceId)).toEqual(["t2", "t1"]);
  });

  test("honours ?limit= (caps the result set)", async () => {
    seedTrace({ traceId: "a" });
    seedTrace({ traceId: "b" });
    seedTrace({ traceId: "c" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getTraces(app, "?limit=2");

    expect(status).toBe(200);
    expect(json.data?.count).toBe(2);
    expect(json.data?.traces?.map((t) => t.traceId)).toEqual(["c", "b"]);
  });

  test("rejects an invalid ?limit= with 400", async () => {
    const app = mountApp({ commandLayer: passLayer() });
    const { status, json } = await getTraces(app, "?limit=-1");
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("rejects an invalid ?origin= with 400", async () => {
    const app = mountApp({ commandLayer: passLayer() });
    const { status, json } = await getTraces(app, "?origin=bogus");
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("rejects an invalid ?status= with 400", async () => {
    const app = mountApp({ commandLayer: passLayer() });
    const { status, json } = await getTraces(app, "?status=weird");
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  test("command layer absent → 503 (cannot authorize, fail closed)", async () => {
    seedTrace({ traceId: "x" });
    const app = mountApp({ commandLayer: undefined });
    const { status, json } = await getTraces(app);
    expect(status).toBe(503);
    expect(json.success).toBe(false);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; sink NOT consulted", async () => {
    seedTrace({ traceId: "secret" });
    const spy = spyLayer();
    const app = mountApp({ commandLayer: spy.layer });

    const { status, json } = await getTraces(app);

    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    // No trace data leaked in the denied response.
    expect(json.data).toBeUndefined();
    // Permission slot ran (and denied) — exactly one dispatch, no second attempt.
    expect(spy.calls).toBe(1);
  });

  test("denying layer just blocks (separate denyLayer helper) → 403", async () => {
    seedTrace({ traceId: "y" });
    const app = mountApp({ commandLayer: denyLayer() });
    const { status, json } = await getTraces(app);
    expect(status).toBe(403);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
  });

  test("tenant slot's resolved tenantId scopes the query (no cross-tenant read)", async () => {
    seedTrace({ traceId: "ta", tenantId: "tenant-a" });
    seedTrace({ traceId: "tb", tenantId: "tenant-b" });
    // The tenant slot pinned tenant-a; a scoped operator must see only tenant-a.
    const app = mountApp({ commandLayer: passLayer({ tenantId: "tenant-a" }) });

    const { status, json } = await getTraces(app, "?tenantId=tenant-b");

    expect(status).toBe(200);
    // The ?tenantId=tenant-b param is IGNORED — the resolved pin always wins.
    expect(json.data?.count).toBe(1);
    expect(json.data?.traces?.[0]?.traceId).toBe("ta");
    expect(json.data?.traces?.[0]?.tenantId).toBe("tenant-a");
  });

  test("unscoped (admin) caller sees all tenants", async () => {
    seedTrace({ traceId: "ua", tenantId: "tenant-a" });
    seedTrace({ traceId: "ub", tenantId: "tenant-b" });
    const app = mountApp({ commandLayer: passLayer() });

    const { status, json } = await getTraces(app);

    expect(status).toBe(200);
    expect(json.data?.count).toBe(2);
  });
});
