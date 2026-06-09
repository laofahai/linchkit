/**
 * "说→有" evolution-loop INTEGRATION SPINE — real components at every seam.
 *
 * WHY this file exists
 * ────────────────────
 * Three sibling smokes each prove ONE segment of the autonomous evolution loop,
 * but each fakes the OTHER side of its seam, so no single test proves the loop
 * assembles as one running system:
 *   - `evolution-run-cycle-smoke.test.ts` drives the REAL server route but injects
 *     a FAKE `EvolutionRuntime` (canned proposals) and an ALLOW-ALL permission
 *     stub — it proves route wiring, not that a real cycle emits proposals nor
 *     that real authorization gates it.
 *   - `proposal-materialize-dryrun-smoke.test.ts` runs the REAL sandbox but with a
 *     FAKE code-gen provider and a FAKE in-memory engine.
 *   - `proposal-graduate-smoke.test.ts` drives the REAL server but stops at the
 *     draft guard, never exercising a real write.
 *
 * This spine closes the gap for the loop's FRONT HALF (autonomous origination):
 * it wires a REAL `createEvolutionRuntime` (real sensor + real view-less ontology
 * + the real default translator registry + the real pre-analysis pipeline — the
 * EXACT option shape `dev-wiring.ts` boots) into the REAL `createServer` route,
 * behind a REAL `cap-permission` middleware whose authorization is decided by a
 * REAL `PermissionRegistry` grant. Then it asserts the cycle's proposal lands as
 * a governed `draft` in the same shared engine the review UI reads.
 *
 * It pins TWO things no existing test does together:
 *   1. A real cycle (Sense→Insight→Proposal) actually EMITS a proposal through
 *      the production server assembly — not a canned fake.
 *   2. The real `cap-permission` middleware GATES it: an actor whose group grants
 *      the documented `grant.evolution.actions.run_cycle` target is ALLOWED; an
 *      actor without it is DENIED. (This is the seam that blocked the loop live —
 *      the route publishes its permission target in `meta.evolution`, a contract
 *      `command-layer.ts` documents and the middleware now honours.)
 *
 * HONEST SCOPE: the autonomous cycle currently originates STRUCTURAL `add_view`
 * proposals (the only built-in translators are `schema_no_view` + rollback-
 * candidate). It does not yet autonomously originate executable ACTION-handler
 * code — that materialize → sandbox dry-run → graduate half is exercised against
 * action proposals by the sibling smokes above. The two halves MEET at the shared
 * ProposalEngine draft store (proven here); autonomous origination of executable
 * code is a later phase. Test 3 below carries the real cycle's draft one seam
 * further (into the real materialize path) to prove the pipe is connected, and
 * asserts the honest outcome for a non-executable view change.
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import { createPermissionMiddlewareRegistration } from "@linchkit/cap-permission";
import type {
  Actor,
  EntityDefinition,
  EntityDescriptor,
  ImpactDataProvider,
  OntologyRegistry,
  PendingProposalStore,
  ProposalChange,
  ProposalDefinition,
} from "@linchkit/core";
import {
  createDedupAnalyzer,
  createDefaultInsightTranslatorRegistry,
  createImpactAnalyzer,
  createPreAnalysisPipeline,
  definePermissionGroup,
} from "@linchkit/core";
import {
  type CodeGenerationProvider,
  type CommandLayer,
  createActionExecutor,
  createCommandLayer,
  createEvolutionRuntime,
  defineSensor,
  type EvolutionRuntime,
  InMemoryExecutionLogger,
  InMemoryStore,
  PermissionRegistry,
  type ProposalEngine,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { getSharedProposalEngine } from "../src/proposal-api";
import {
  type MaterializeEngine,
  runProposalMaterialization,
} from "../src/proposal-materialize-api";
import { createServer } from "../src/server";

const BASE = "http://local.test";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

// ── Real evolution-runtime composition (mirrors dev-wiring.ts exactly) ────────

/**
 * A view-less ontology carrying ONE entity — the trigger for the `schema_no_view`
 * structural issue → insight → `add_view` proposal pipeline. The entity name is
 * caller-supplied so every test mints a globally-unique one, keeping the shared
 * engine's capability+change-set dedup collision-free across the batched run.
 */
function createViewlessOntology(entityName: string): OntologyRegistry {
  const schemas: Record<string, Partial<EntityDescriptor>> = {
    [entityName]: {
      views: [],
      actions: [],
      fields: {
        id: { type: "string" },
        value: { type: "number" },
      } as EntityDescriptor["fields"],
    },
  };
  return {
    describe: (name) => schemas[name] as EntityDescriptor | undefined,
    listEntities: () => Object.keys(schemas),
    searchEntities: () => [],
    actionsFor: () => [],
    rulesFor: () => [],
    stateFor: () => undefined,
    viewsFor: () => [],
    flowsFor: () => [],
    handlersFor: () => [],
    relatedEntities: () => [],
    entitiesImplementing: () => [],
    toJSON: () => ({}) as ReturnType<OntologyRegistry["toJSON"]>,
    toMarkdown: () => "",
    searchByIntent: () => [],
    searchByDomain: () => [],
    getSemanticsFor: () => undefined,
    dependencyGraph: (ref) => ({ root: ref, nodes: [ref], edges: [] }),
    impactAnalysis: (ref) => [[ref]],
  };
}

/** Single-emit sensor so one `runCycle()` ingests exactly one signal. */
function createOneShotSensor(entityName: string) {
  let emitted = false;
  return defineSensor({
    name: `${entityName}_tick`,
    source: "server",
    entity: entityName,
    async detect(ctx) {
      if (emitted) return null;
      emitted = true;
      return {
        sensor: `${entityName}_tick`,
        source: "server",
        timestamp: ctx.timestamp,
        value: 42,
        baseline: 40,
        deviation: 0.05,
        confidence: 0.95,
        context: { entity: entityName, metric: "value", tenantId: "dev" },
      };
    },
  });
}

function createEmptyPendingProposalStore(): PendingProposalStore {
  return {
    async listPending(): Promise<ProposalDefinition[]> {
      return [];
    },
  };
}

function createEmptyImpactDataProvider(): ImpactDataProvider {
  return {
    async countRecords(): Promise<number> {
      return 0;
    },
    async sampleRecordIds(): Promise<string[]> {
      return [];
    },
  };
}

/** Build a REAL evolution runtime for `entityName`, stamping `capability`. */
function buildRealRuntime(entityName: string, capability: string): EvolutionRuntime {
  return createEvolutionRuntime({
    sensors: [createOneShotSensor(entityName)],
    ontology: createViewlessOntology(entityName),
    translatorRegistry: createDefaultInsightTranslatorRegistry(),
    proposalCapability: capability,
    proposalPreAnalysisPipeline: createPreAnalysisPipeline({
      analyzers: [
        createDedupAnalyzer({ store: createEmptyPendingProposalStore() }),
        createImpactAnalyzer({ dataProvider: createEmptyImpactDataProvider() }),
      ],
    }),
  });
}

// ── Real cap-permission grant for the documented evolution target ─────────────

const EVOLUTION_OPERATOR = "evolution_operator";

/**
 * A real `PermissionRegistry` whose `evolution_operator` group grants the
 * NATURAL run-cycle target (`grant.evolution.actions.run_cycle`). This is the
 * grant shape a human would author; the middleware resolves the run-cycle
 * dispatch's `meta.evolution.operation` to exactly this target.
 */
function evolutionRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register(
    definePermissionGroup({
      name: EVOLUTION_OPERATOR,
      label: "Evolution Operator",
      grant: { evolution: { actions: { run_cycle: true } } },
    }),
  );
  return registry;
}

const OPERATOR_ACTOR: Actor = { type: "human", id: "op_spine", groups: [EVOLUTION_OPERATOR] };
const STRANGER_ACTOR: Actor = { type: "human", id: "stranger_spine", groups: ["unrelated_group"] };

/**
 * Build the REAL server via the canonical factory with a REAL cap-permission
 * middleware backed by a real grant, a REAL evolution runtime, and a fixed actor.
 */
function buildApp(opts: { runtime: EvolutionRuntime; actor: Actor }): {
  handle: (req: Request) => Promise<Response>;
} {
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer: CommandLayer = createCommandLayer({ executor });
  // The REAL permission slot — NOT an allow-all stub. Decides via the registry.
  commandLayer.use(createPermissionMiddlewareRegistration({ registry: evolutionRegistry() }));
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, {
    executor,
    commandLayer,
    evolutionRuntime: opts.runtime,
    resolveRequestActor: () => opts.actor,
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
  const body = await res.text();
  let json: RunCycleJson;
  try {
    json = JSON.parse(body) as RunCycleJson;
  } catch {
    throw new Error(`run-cycle returned non-JSON (status ${res.status}): ${body.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

function sharedEngine(): ProposalEngine {
  return getSharedProposalEngine();
}

/**
 * A code-gen provider that records whether it was asked to generate anything.
 * For a view change the materializer must NOT call it (no executable source), so
 * `calls.count === 0` is the assertion that pins the code-gen no-op boundary.
 */
function makeRecordingProvider(): { provider: CodeGenerationProvider; calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    provider: {
      async generateCode() {
        calls.count += 1;
        return "export const generated = 1;\n";
      },
    },
  };
}

let uid = 0;
function uniqueNames(): { entity: string; capability: string } {
  uid += 1;
  const suffix = `${uid}-${Date.now().toString(36)}`;
  return { entity: `spine_metric_${suffix}`, capability: `cap-spine-${suffix}` };
}

describe("说→有 evolution-loop spine — real cycle + real authz + real draft", () => {
  test("operator with grant: real cycle emits a proposal that lands as a governed DRAFT", async () => {
    const { entity, capability } = uniqueNames();
    const runtime = buildRealRuntime(entity, capability);
    const app = buildApp({ runtime, actor: OPERATOR_ACTOR });

    const { status, json } = await postRunCycle(app);

    // The run-cycle dispatch passed the REAL permission slot (grant matched the
    // documented meta.evolution target) and the REAL cycle produced a proposal.
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.created).toBe(1);
    expect(json.data?.total).toBe(1);
    expect(json.data?.createdIds).toHaveLength(1);

    // The proposal really landed in the shared governance engine the review UI
    // reads — status `draft`, NEVER auto-approved/graduated, minted with a fresh
    // engine id, and it is a structural add_view origination for our entity.
    const createdId = json.data?.createdIds?.[0] as string;
    const persisted = sharedEngine().getProposal(createdId);
    expect(persisted.status).toBe("draft");
    expect(persisted.capability).toBe(capability);
    const addViewChange = persisted.changes.find(
      (c) => c.target === "view" && c.operation === "create",
    );
    expect(addViewChange).toBeDefined();
  });

  test("stranger without the grant: run-cycle is DENIED and NOTHING is persisted", async () => {
    const { entity, capability } = uniqueNames();
    const runtime = buildRealRuntime(entity, capability);
    const app = buildApp({ runtime, actor: STRANGER_ACTOR });

    const { status, json } = await postRunCycle(app);

    // The REAL permission engine default-denies an actor whose groups grant no
    // evolution target — the canonical AUTHZ_DENIED envelope, NOT an allow-all leak.
    expect(status === 401 || status === 403).toBe(true);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");

    // The cycle never ran past the permission slot, so no draft exists for it.
    const drafts = sharedEngine().listProposals({ status: "draft" });
    expect(drafts.filter((p) => p.capability === capability)).toHaveLength(0);
  });

  test("the cycle's real draft reaches the materialize seam — a view change is a code-gen no-op today (honest boundary)", async () => {
    // Carry the cycle's REAL draft (not a hand-built fixture) one seam further,
    // into the real materialize orchestrator, to prove the autonomously-originated
    // proposal is actually WIRED to the code-materialization path.
    //
    // HONEST BOUNDARY (the truthful end-to-end outcome): the autonomous cycle
    // currently originates a structural `view` change, and the materializer only
    // synthesises code for executable targets (actions). So the view change is a
    // code-gen NO-OP — no `generatedSource`, no `materializationStatus`, and no
    // execution dry-run runs (there is no handler to sandbox). The orchestrator
    // still returns `ok` with `allMaterialized: true` (vacuously — zero
    // materializable changes, zero failures), and the proposal stays a `draft`.
    // The executable-code half (materialize → REAL sandbox dry-run → graduate) is
    // exercised against ACTION proposals by the sibling `*-dryrun-smoke` /
    // `*-graduate-smoke` tests. When autonomous origination of action handlers
    // lands, THIS same draft would instead carry `generatedSource` + a real
    // `dryRunStatus` — this assertion is the canary that pins today's boundary.
    const { entity, capability } = uniqueNames();
    const runtime = buildRealRuntime(entity, capability);
    const app = buildApp({ runtime, actor: OPERATOR_ACTOR });

    const { json } = await postRunCycle(app);
    const createdId = json.data?.createdIds?.[0] as string;
    expect(createdId).toBeTruthy();

    const engine = sharedEngine() as unknown as MaterializeEngine;
    const provider = makeRecordingProvider();
    const outcome = await runProposalMaterialization(createdId, {
      engine,
      provider: provider.provider,
      qualityGate: { check: async () => [] },
    });

    // The orchestrator ran end-to-end against the real cycle draft (draft-only,
    // never approves/graduates) and returned a structured `ok` — the seam is
    // connected, not throwing.
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.allMaterialized).toBe(true);
      const change = outcome.proposal.changes[0] as ProposalChange & {
        materializationStatus?: string;
        dryRunStatus?: string;
        generatedSource?: string;
      };
      expect(change.target).toBe("view");
      // No code synthesised for a view change → provider never invoked, no source,
      // no durable materialization/dry-run signal stamped.
      expect(provider.calls.count).toBe(0);
      expect(change.generatedSource).toBeUndefined();
      expect(change.materializationStatus).toBeUndefined();
      expect(change.dryRunStatus).toBeUndefined();
    }
    // The proposal is still a draft — materialize never promotes it.
    expect(sharedEngine().getProposal(createdId).status).toBe("draft");
  });
});
