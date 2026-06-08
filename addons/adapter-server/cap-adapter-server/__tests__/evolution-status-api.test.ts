/**
 * Evolution scheduler status endpoint tests — GET /api/evolution/scheduler-status.
 *
 * Pins the read-only liveness surface: the CommandLayer permission gate
 * (503 no-layer / 401-403 denied), the `{ configured: false }` answer when no
 * scheduler is wired (cadence disabled), and the full status shape (with Date
 * fields serialized as ISO strings) when one is.
 *
 * Endpoint dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer } from "@linchkit/core";
import { createEvolutionScheduler, type EvolutionScheduler } from "@linchkit/core/server";
import { Elysia } from "elysia";
import { mountEvolutionStatusRoutes } from "../src/routes/evolution-status-api";
import type { ServerOptions } from "../src/server";

const BASE = "http://local.test";
const SILENT = { debug() {}, info() {}, warn() {}, error() {} } as const;

interface StatusJson {
  success: boolean;
  data?: {
    configured?: boolean;
    running?: boolean;
    intervalMs?: number;
    ticksStarted?: number;
    ticksCompleted?: number;
    lastTickStartedAt?: string | null;
    lastTickCompletedAt?: string | null;
    lastTickDurationMs?: number | null;
    lastError?: string | null;
    consecutiveErrors?: number;
  };
  error?: { code?: string; message?: string };
}

/** Permissive command layer; `data` carries the synthetic tenant slot result. */
function passLayer(data: Record<string, unknown> = {}): CommandLayer {
  return { execute: async () => ({ success: true, data }) } as unknown as CommandLayer;
}

function mountApp(opts: { commandLayer?: CommandLayer; scheduler?: EvolutionScheduler }): Elysia {
  const app = new Elysia();
  mountEvolutionStatusRoutes(app, {
    commandLayer: opts.commandLayer,
    evolutionScheduler: opts.scheduler,
  } as unknown as ServerOptions);
  return app;
}

async function getStatus(app: Elysia): Promise<{ status: number; json: StatusJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/evolution/scheduler-status`, { method: "GET" }),
  );
  return { status: res.status, json: (await res.json()) as StatusJson };
}

describe("GET /api/evolution/scheduler-status", () => {
  test("no scheduler wired → 200 { configured: false }", async () => {
    const app = mountApp({ commandLayer: passLayer(), scheduler: undefined });
    const { status, json } = await getStatus(app);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.configured).toBe(false);
    // No status fields leak when there is no scheduler.
    expect(json.data?.running).toBeUndefined();
  });

  test("scheduler wired → 200 with the full status shape (fresh scheduler)", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {},
      intervalMs: 60_000,
      logger: SILENT,
    });
    const app = mountApp({ commandLayer: passLayer(), scheduler });

    const { status, json } = await getStatus(app);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.configured).toBe(true);
    expect(json.data?.running).toBe(false);
    expect(json.data?.intervalMs).toBe(60_000);
    expect(json.data?.ticksStarted).toBe(0);
    expect(json.data?.ticksCompleted).toBe(0);
    expect(json.data?.lastTickStartedAt).toBeNull();
    expect(json.data?.lastTickCompletedAt).toBeNull();
    expect(json.data?.lastTickDurationMs).toBeNull();
    expect(json.data?.lastError).toBeNull();
    expect(json.data?.consecutiveErrors).toBe(0);
  });

  test("Date fields are serialized as ISO strings after a tick", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {},
      intervalMs: 1000,
      logger: SILENT,
    });
    await scheduler.runOnce();
    const app = mountApp({ commandLayer: passLayer(), scheduler });

    const { json } = await getStatus(app);
    expect(json.data?.configured).toBe(true);
    expect(json.data?.ticksStarted).toBe(1);
    expect(json.data?.ticksCompleted).toBe(1);
    // ISO-8601 string, round-trips through Date without becoming Invalid Date.
    const startedAt = json.data?.lastTickStartedAt;
    expect(typeof startedAt).toBe("string");
    expect(Number.isNaN(new Date(startedAt as string).getTime())).toBe(false);
  });

  test("reflects a throwing tick's lastError + consecutiveErrors", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {
        throw new Error("cycle boom");
      },
      intervalMs: 1000,
      logger: SILENT,
      onError: () => {},
    });
    await scheduler.runOnce();
    const app = mountApp({ commandLayer: passLayer(), scheduler });

    const { json } = await getStatus(app);
    expect(json.data?.lastError).toBe("cycle boom");
    expect(json.data?.consecutiveErrors).toBe(1);
  });

  test("command layer absent → 503 (cannot authorize, fail closed)", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {},
      intervalMs: 1000,
      logger: SILENT,
    });
    const app = mountApp({ commandLayer: undefined, scheduler });
    const { status, json } = await getStatus(app);
    expect(status).toBe(503);
    expect(json.success).toBe(false);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; status not leaked", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {},
      intervalMs: 1000,
      logger: SILENT,
    });
    const denying = {
      execute: async () => ({ success: false, data: { error: "not allowed" } }),
    } as unknown as CommandLayer;
    const app = mountApp({ commandLayer: denying, scheduler });

    const { status, json } = await getStatus(app);
    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    // Denied callers learn nothing about the scheduler.
    expect(json.data).toBeUndefined();
  });
});
