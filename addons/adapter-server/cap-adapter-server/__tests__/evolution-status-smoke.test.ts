/**
 * Evolution scheduler status — REAL server-assembly smoke test.
 *
 * The sibling `evolution-status-api.test.ts` pins the route in isolation
 * (a hand-built Elysia app with only the status routes mounted). This smoke
 * test instead drives the route through the canonical `createServer(...)`
 * factory — the SAME assembly path `http-transport.ts` boots in production —
 * to prove the endpoint is actually wired into the real server (not merely
 * mountable on its own), and that it reflects the scheduler's LIVE runtime
 * state.
 *
 * It exercises real components end-to-end: a real `createEvolutionScheduler`,
 * a real `createCommandLayer`, a real GraphQL schema, and the real REST
 * surface — then advances the scheduler with `runOnce()` and reads the change
 * back out over HTTP. No mock seams, so a broken wiring can't pass.
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer, EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  createEvolutionScheduler,
  type EvolutionScheduler,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

const BASE = "http://local.test";
const SILENT = { debug() {}, info() {}, warn() {}, error() {} } as const;

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

/**
 * Register an allow-all permission middleware. The status read dispatches with
 * `skipActionSlots: true`, which is fail-closed: the CommandLayer rejects it
 * unless a permission middleware is present (the executor's default-allow does
 * NOT apply to non-action dispatches). In a real deployment cap-permission
 * provides this slot; here a minimal pass-through stands in for "the read is
 * authorized" so we can observe the rest of the wiring.
 */
function grantReadPermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_read",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

interface StatusResponse {
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

/** Build the real server via the canonical factory, optionally with a scheduler. */
function buildApp(
  evolutionScheduler?: EvolutionScheduler,
  opts: { withPermission?: boolean } = {},
): { handle: (req: Request) => Promise<Response> } {
  const { withPermission = true } = opts;
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer = createCommandLayer({ executor });
  if (withPermission) {
    grantReadPermission(commandLayer);
  }
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, { executor, commandLayer, evolutionScheduler });
}

async function getStatus(app: {
  handle: (req: Request) => Promise<Response>;
}): Promise<{ status: number; body: StatusResponse }> {
  const res = await app.handle(new Request(`${BASE}/api/evolution/scheduler-status`));
  const body = (await res.json()) as StatusResponse;
  return { status: res.status, body };
}

describe("evolution scheduler-status — real createServer smoke", () => {
  test("reports configured:false when no scheduler is wired into the real server", async () => {
    const app = buildApp(undefined);
    const { status, body } = await getStatus(app);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.configured).toBe(false);
  });

  test("surfaces a wired scheduler's LIVE state after a real tick", async () => {
    let ticks = 0;
    const scheduler = createEvolutionScheduler({
      tick: () => {
        ticks += 1;
      },
      intervalMs: 60_000,
      logger: SILENT,
    });
    const app = buildApp(scheduler);

    // Before any tick: configured + idle counters, surfaced through the real route.
    const before = await getStatus(app);
    expect(before.status).toBe(200);
    expect(before.body.data?.configured).toBe(true);
    expect(before.body.data?.running).toBe(false);
    expect(before.body.data?.intervalMs).toBe(60_000);
    expect(before.body.data?.ticksStarted).toBe(0);
    expect(before.body.data?.lastTickStartedAt).toBeNull();

    // Advance the scheduler deterministically (no timers) and read it back over HTTP.
    const ran = await scheduler.runOnce();
    expect(ran).toBe(true);
    expect(ticks).toBe(1);

    const after = await getStatus(app);
    expect(after.body.data?.ticksStarted).toBe(1);
    expect(after.body.data?.ticksCompleted).toBe(1);
    expect(after.body.data?.lastError).toBeNull();
    expect(after.body.data?.consecutiveErrors).toBe(0);
    // Timestamp serialized as an ISO string over the wire (not a raw Date).
    expect(typeof after.body.data?.lastTickStartedAt).toBe("string");
    expect(Number.isNaN(Date.parse(after.body.data?.lastTickStartedAt ?? ""))).toBe(false);
    expect(after.body.data?.lastTickDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("permission slot is never skipped: real server fails closed without a permission middleware", async () => {
    // No permission middleware → the skipActionSlots status read must be rejected
    // (PERMISSION.MIDDLEWARE_MISSING), proving the real assembly enforces the
    // permission slot end-to-end rather than leaking liveness to an unauthorized
    // caller. A scheduler IS wired, so a leak would expose real state.
    const scheduler = createEvolutionScheduler({
      tick: () => {},
      intervalMs: 60_000,
      logger: SILENT,
    });
    const app = buildApp(scheduler, { withPermission: false });
    const res = await app.handle(new Request(`${BASE}/api/evolution/scheduler-status`));
    expect(res.status).toBe(422);
    const body = (await res.json()) as StatusResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("PERMISSION.MIDDLEWARE_MISSING");
    // Liveness must NOT leak to an unauthorized caller.
    expect(body.data).toBeUndefined();
  });

  test("a failing tick's error streak is observable through the real route", async () => {
    const scheduler = createEvolutionScheduler({
      tick: () => {
        throw new Error("smoke boom");
      },
      intervalMs: 60_000,
      logger: SILENT,
      onError: () => {},
    });
    const app = buildApp(scheduler);

    await scheduler.runOnce();
    const { body } = await getStatus(app);
    expect(body.data?.configured).toBe(true);
    expect(body.data?.ticksCompleted).toBe(1);
    expect(body.data?.lastError).toBe("smoke boom");
    expect(body.data?.consecutiveErrors).toBe(1);
  });
});
