/**
 * On-demand evolution cycle → draft — REAL server-assembly smoke test.
 *
 * The sibling `evolution-cycle-api.test.ts` pins the route in isolation: it
 * mounts ONLY `mountEvolutionCycleRoutes` onto a hand-built Elysia app and
 * authorizes with a FAKE `passLayer()` whose `execute()` is a one-line stub.
 * That proves the handler's branching but NOT that the route is actually wired
 * into the production server, nor that a REAL CommandLayer's permission slot
 * gates it end-to-end.
 *
 * This smoke instead drives `POST /api/evolution/run-cycle` through the
 * canonical `createServer(...)` factory — the SAME assembly path
 * `http-transport.ts` boots in production — with:
 *   - a REAL `createCommandLayer({ executor })` + an allow-all permission
 *     middleware (the `skipActionSlots` dispatch fails closed without one:
 *     `PERMISSION.MIDDLEWARE_MISSING`),
 *   - a REAL GraphQL schema (`buildGraphQLSchema`),
 *   - an injected `evolutionRuntime` whose `evolutionCycle.runCycle()` returns
 *     one proposal.
 * The whole point is REAL assembly: a broken `createServer` wiring (route not
 * mounted, options not threaded, permission slot bypassed) cannot pass here.
 *
 * Draft read-back: the route persists into the PROCESS-WIDE shared engine
 * (`getSharedProposalEngine()` in `proposal-api.ts`), not an injectable one —
 * so a draft is read back via that shared engine's `listProposals(...)`. To
 * keep the read deterministic under the batched runner (the shared singleton
 * survives across suites/tests and dedups by capability+change-set), every
 * proposal this file mints is GLOBALLY UNIQUE (own capability + change name),
 * matching the dedup-safety convention of `evolution-cycle-api.test.ts`.
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer, EntityDefinition, ProposalDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  type EvolutionRuntime,
  InMemoryExecutionLogger,
  InMemoryStore,
  type ProposalEngine,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { getSharedProposalEngine } from "../src/proposal-api";
import { createServer } from "../src/server";

const BASE = "http://local.test";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

/**
 * Register an allow-all permission middleware. The run-cycle route dispatches
 * with `skipActionSlots: true`, which is fail-closed: the CommandLayer rejects
 * it unless a permission middleware is present (the executor's default-allow
 * does NOT apply to non-action dispatches). In a real deployment cap-permission
 * provides this slot; here a minimal pass-through stands in for "the mutation is
 * authorized" so we can observe the rest of the wiring run the cycle.
 */
function grantRunCyclePermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_run_cycle",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

/**
 * Globally-unique cycle proposal fixture (shaped like `cycleProposal()` in
 * evolution-scheduler-wiring.test.ts). The unique capability + change name keep
 * the process-wide shared engine's capability+change-set dedup from colliding
 * across tests or batches, so `created` is deterministically 1 per fresh
 * proposal and the read-back below matches exactly this draft.
 */
let uid = 0;
function uniqueProposal(): ProposalDefinition {
  uid += 1;
  const now = new Date();
  return {
    id: `run-cycle-smoke-src-${uid}`,
    title: `Run-cycle smoke proposal ${uid}`,
    description: "Draft minted by an on-demand evolution cycle (real-server smoke)",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: `cap-run-cycle-smoke-${uid}`,
    changeType: "minor",
    changes: [{ target: "rule", operation: "create", name: `smoke_rule_${uid}` }],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [`smoke_rule_${uid}`],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fake EvolutionRuntime whose cycle returns the given proposals and records
 * each invocation, so the test can assert the cycle did (or did NOT) run when
 * dispatched through the real server.
 */
function makeRuntime(proposals: ProposalDefinition[]): {
  runtime: EvolutionRuntime;
  calls: Array<{ tenantId?: string }>;
} {
  const calls: Array<{ tenantId?: string }> = [];
  const runtime = {
    evolutionCycle: {
      async runCycle(ctx: { timestamp: Date; tenantId?: string }) {
        calls.push({ tenantId: ctx.tenantId });
        return { proposals };
      },
    },
  } as unknown as EvolutionRuntime;
  return { runtime, calls };
}

/** Build the REAL server via the canonical factory. */
function buildApp(opts: { runtime?: EvolutionRuntime; withPermission?: boolean } = {}): {
  handle: (req: Request) => Promise<Response>;
} {
  const { runtime, withPermission = true } = opts;
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer = createCommandLayer({ executor });
  if (withPermission) {
    grantRunCyclePermission(commandLayer);
  }
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, {
    executor,
    commandLayer,
    evolutionRuntime: runtime,
  });
}

interface RunCycleJson {
  success: boolean;
  data?: { created?: number; deduped?: number; total?: number; createdIds?: string[] };
  error?: { code?: string; message?: string };
}

async function postRunCycle(app: {
  handle: (req: Request) => Promise<Response>;
}): Promise<{ status: number; json: RunCycleJson }> {
  const res = await app.handle(new Request(`${BASE}/api/evolution/run-cycle`, { method: "POST" }));
  // Read the body as text first: a 500 / assembly crash can return non-JSON
  // (HTML / plain text), and a bare `res.json()` would throw an opaque
  // SyntaxError that masks the real failure. Surface the raw body instead.
  const body = await res.text();
  let json: RunCycleJson;
  try {
    json = JSON.parse(body) as RunCycleJson;
  } catch {
    throw new Error(`run-cycle returned non-JSON (status ${res.status}): ${body.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

/** The shared engine the route persists drafts into — read back through it. */
function sharedEngine(): ProposalEngine {
  return getSharedProposalEngine();
}

describe("POST /api/evolution/run-cycle — real createServer smoke", () => {
  test("happy path → 200; cycle ran and its proposal landed as a DRAFT in the shared engine", async () => {
    const proposal = uniqueProposal();
    const { runtime, calls } = makeRuntime([proposal]);
    const app = buildApp({ runtime });

    const { status, json } = await postRunCycle(app);

    // 200 + the cycle actually executed through the real server.
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(json.data?.total).toBe(1);
    expect(json.data?.created).toBe(1);
    expect(json.data?.deduped).toBe(0);
    expect(json.data?.createdIds).toHaveLength(1);

    // The draft really landed in the shared governance engine the Proposal
    // review API reads from — status `draft`, NEVER auto-approved/graduated,
    // and minted with a fresh engine id (not copied from the source proposal).
    const createdId = json.data?.createdIds?.[0] as string;
    const persisted = sharedEngine().getProposal(createdId);
    expect(persisted.status).toBe("draft");
    expect(persisted.id).not.toBe(proposal.id);
    expect(persisted.capability).toBe(proposal.capability);

    // It is discoverable via the same draft filter the review pipeline uses,
    // and it is exactly the draft this cycle minted (matched by its unique
    // capability so the assertion is robust to other drafts in the singleton).
    const drafts = sharedEngine().listProposals({ status: "draft" });
    const mine = drafts.filter((p) => p.capability === proposal.capability);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(createdId);
    expect(mine[0]?.status).toBe("draft");
  });

  test("permission enforced end-to-end: no permission middleware → 422 PERMISSION.MIDDLEWARE_MISSING, cycle NOT run", async () => {
    // No permission middleware on the real CommandLayer → the skipActionSlots
    // dispatch fails closed BEFORE the runtime is touched. This proves the real
    // assembly enforces the permission slot end-to-end (CommandLayer is real,
    // not the `passLayer()` stub the isolated unit test uses). A runtime IS
    // wired, so a leak would actually run the cycle — it must not.
    const proposal = uniqueProposal();
    const { runtime, calls } = makeRuntime([proposal]);
    const app = buildApp({ runtime, withPermission: false });

    const { status, json } = await postRunCycle(app);

    // resolveStatusCode maps the unrecognized PERMISSION.MIDDLEWARE_MISSING code
    // to its 422 default (it is not 401/403, so not the canonical AUTHZ_DENIED
    // envelope); the route forwards the middleware code verbatim.
    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("PERMISSION.MIDDLEWARE_MISSING");
    // The cycle never ran, so nothing was persisted for this capability.
    expect(calls).toHaveLength(0);
    const drafts = sharedEngine().listProposals({ status: "draft" });
    expect(drafts.filter((p) => p.capability === proposal.capability)).toHaveLength(0);
  });

  test("no evolution runtime wired → 501 (graceful degradation, not 500)", async () => {
    // A fully real server with NO evolutionRuntime injected: the route degrades
    // to its documented 501 (runtime not configured) rather than throwing 500.
    const app = buildApp({ runtime: undefined });

    const { status, json } = await postRunCycle(app);

    expect(status).toBe(501);
    expect(json.success).toBe(false);
    expect(json.data).toBeUndefined();
  });
});
