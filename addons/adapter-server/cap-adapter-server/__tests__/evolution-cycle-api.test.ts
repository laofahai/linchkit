/**
 * On-demand evolution cycle endpoint tests — POST /api/evolution/run-cycle.
 *
 * Pins the route added in #490 (cycle→draft bridge): the CommandLayer permission
 * gate, every status-code path (501 / 503 / 401-403 / 500 / 200), the tenant the
 * tenant slot resolved being propagated into `runCycle`, and the cycle output
 * actually landing as `draft` proposals in the shared governance engine.
 *
 * Endpoint dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer, EvolutionRuntime, ProposalDefinition } from "@linchkit/core";
import { Elysia } from "elysia";
import { getSharedProposalEngine } from "../src/proposal-api";
import { mountEvolutionCycleRoutes } from "../src/routes/evolution-cycle-api";
import type { ServerOptions } from "../src/server";

const BASE = "http://local.test";

interface RunCycleJson {
  success: boolean;
  data?: { created?: number; deduped?: number; total?: number; createdIds?: string[] };
  error?: { code?: string; message?: string };
}

// Each proposal is globally unique (own capability + change name) so the shared
// engine's capability+change-set dedup never collides across tests or batches —
// `created` is therefore deterministically 1 per fresh proposal.
let uid = 0;
function uniqueProposal(): ProposalDefinition {
  uid += 1;
  const now = new Date();
  return {
    id: `cycle-src-${uid}`,
    title: `Cycle proposal ${uid}`,
    description: "Draft minted by an on-demand evolution cycle",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: `cap-run-cycle-wiring-test-${uid}`,
    changeType: "minor",
    changes: [{ target: "rule", operation: "create", name: `cycle_rule_${uid}` }],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [`cycle_rule_${uid}`],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as ProposalDefinition;
}

/** Fake runtime whose cycle returns the given proposals and records each call. */
function makeRuntime(opts: {
  proposals?: ProposalDefinition[];
  throws?: boolean;
  noCycle?: boolean;
}): { runtime: EvolutionRuntime; calls: Array<{ tenantId?: string }> } {
  const calls: Array<{ tenantId?: string }> = [];
  if (opts.noCycle) {
    // Runtime present, but `evolutionCycle` missing (partial / mock construction).
    return { runtime: {} as unknown as EvolutionRuntime, calls };
  }
  const runtime = {
    evolutionCycle: {
      async runCycle(ctx: { timestamp: Date; tenantId?: string }) {
        calls.push({ tenantId: ctx.tenantId });
        if (opts.throws) throw new Error("cycle blew up");
        return { proposals: opts.proposals ?? [] };
      },
    },
  } as unknown as EvolutionRuntime;
  return { runtime, calls };
}

/** Permissive command layer; `data` carries the synthetic tenant slot result. */
function passLayer(data: Record<string, unknown> = {}): CommandLayer {
  return { execute: async () => ({ success: true, data }) } as unknown as CommandLayer;
}

function mountApp(opts: { commandLayer?: CommandLayer; runtime?: EvolutionRuntime }): Elysia {
  const app = new Elysia();
  mountEvolutionCycleRoutes(app, {
    commandLayer: opts.commandLayer,
    evolutionRuntime: opts.runtime,
  } as unknown as ServerOptions);
  return app;
}

async function postRunCycle(app: Elysia): Promise<{ status: number; json: RunCycleJson }> {
  const res = await app.handle(new Request(`${BASE}/api/evolution/run-cycle`, { method: "POST" }));
  return { status: res.status, json: (await res.json()) as RunCycleJson };
}

describe("POST /api/evolution/run-cycle", () => {
  test("happy path → 200; cycle output persisted as a draft in the shared engine", async () => {
    const proposal = uniqueProposal();
    const { runtime } = makeRuntime({ proposals: [proposal] });
    const app = mountApp({ commandLayer: passLayer(), runtime });

    const { status, json } = await postRunCycle(app);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.total).toBe(1);
    expect(json.data?.created).toBe(1);
    expect(json.data?.deduped).toBe(0);
    expect(json.data?.createdIds).toHaveLength(1);

    // The draft really landed in the shared governance engine (status === draft,
    // never copied from the source id / status).
    const createdId = json.data?.createdIds?.[0] as string;
    const persisted = getSharedProposalEngine().getProposal(createdId);
    expect(persisted.status).toBe("draft");
    expect(persisted.id).not.toBe(proposal.id);
    expect(persisted.capability).toBe(proposal.capability);
  });

  test("propagates the tenant slot's resolved tenantId into runCycle", async () => {
    const { runtime, calls } = makeRuntime({ proposals: [] });
    const app = mountApp({ commandLayer: passLayer({ tenantId: "tenant-99" }), runtime });

    const { status } = await postRunCycle(app);

    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenantId).toBe("tenant-99");
  });

  test("evolution runtime not configured → 501", async () => {
    const app = mountApp({ commandLayer: passLayer(), runtime: undefined });
    const { status, json } = await postRunCycle(app);
    expect(status).toBe(501);
    expect(json.success).toBe(false);
  });

  test("runtime present but evolutionCycle missing (partial) → 501", async () => {
    const { runtime } = makeRuntime({ noCycle: true });
    const app = mountApp({ commandLayer: passLayer(), runtime });
    const { status, json } = await postRunCycle(app);
    expect(status).toBe(501);
    expect(json.success).toBe(false);
  });

  test("command layer absent → 503 (cannot authorize, fail closed)", async () => {
    const { runtime } = makeRuntime({ proposals: [uniqueProposal()] });
    const app = mountApp({ commandLayer: undefined, runtime });
    const { status, json } = await postRunCycle(app);
    expect(status).toBe(503);
    expect(json.success).toBe(false);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; cycle NOT run", async () => {
    const { runtime, calls } = makeRuntime({ proposals: [uniqueProposal()] });
    const denying = {
      execute: async () => ({ success: false, data: { error: "not allowed" } }),
    } as unknown as CommandLayer;
    const app = mountApp({ commandLayer: denying, runtime });

    const { status, json } = await postRunCycle(app);

    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    // Permission slot ran BEFORE the runtime — an unauthorized call never runs the cycle.
    expect(calls).toHaveLength(0);
  });

  test("runCycle throwing → 500 envelope", async () => {
    const { runtime } = makeRuntime({ throws: true });
    const app = mountApp({ commandLayer: passLayer(), runtime });
    const { status, json } = await postRunCycle(app);
    expect(status).toBe(500);
    expect(json.success).toBe(false);
  });
});
