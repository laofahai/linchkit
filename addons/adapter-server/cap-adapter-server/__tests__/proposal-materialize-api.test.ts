/**
 * Proposal code materialization — unit + endpoint tests (G5 Phase 4).
 *
 * Covers the injectable orchestrator (`runProposalMaterialization`) and the
 * Elysia route (`mountProposalMaterializeAPI`). The code-generation provider is
 * ALWAYS an injected fake — no real model is called. A spy asserts the provider
 * is never invoked when a guard (draft-only / authz / not-configured) trips, and
 * that nothing is written back on those paths.
 *
 * Endpoint tests dispatch via `app.handle(new Request(...))` (in-process,
 * port-free). `app.listen(PORT)` is intentionally avoided — a bound socket per
 * suite SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type {
  CommandLayer,
  OntologyRegistry,
  ProposalChange,
  ProposalDefinition,
} from "@linchkit/core";
import type { CodeGenerationProvider, QualityGateRunner } from "@linchkit/core/server";
import { Elysia } from "elysia";
import {
  type MaterializeEngine,
  mountProposalMaterializeAPI,
  runProposalMaterialization,
} from "../src/proposal-materialize-api";

const BASE = "http://local.test";
const GOOD = "export const deduct_inventory = 1;";

// ── Fixtures ─────────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-abc12345",
    title: "Add deduct_inventory action",
    description: "When an order is approved, deduct inventory",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: "deduct_inventory" }],
    impact: {
      schemasAffected: [],
      actionsAffected: ["deduct_inventory"],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProposalDefinition;
}

/** Provider spy returning a fixed source (or throwing). Records call count. */
function makeProvider(opts: { source?: string; throws?: boolean } = {}): {
  provider: CodeGenerationProvider;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const provider: CodeGenerationProvider = {
    async generateCode() {
      calls.count += 1;
      if (opts.throws) throw new Error("model exploded");
      return opts.source ?? GOOD;
    },
  };
  return { provider, calls };
}

/** A gate that passes everything (no Bun transpiler dependency in unit tests). */
const PASS_GATE: QualityGateRunner = { check: async () => [] };

/** Engine fake that mirrors the real draft-only `updateProposal` contract. */
function makeEngine(proposal: ProposalDefinition | undefined): {
  engine: MaterializeEngine;
  updates: Array<{ id: string; changes?: ProposalChange[] }>;
} {
  const updates: Array<{ id: string; changes?: ProposalChange[] }> = [];
  let current = proposal;
  const engine: MaterializeEngine = {
    getProposal(id) {
      if (!current || current.id !== id) throw new Error(`Proposal "${id}" not found`);
      return current;
    },
    updateProposal(id, u) {
      if (!current || current.id !== id) throw new Error(`Proposal "${id}" not found`);
      if (current.status !== "draft") {
        throw new Error(`Cannot update proposal "${id}": expected status "draft"`);
      }
      updates.push({ id, changes: u.changes });
      current = { ...current, changes: u.changes ?? current.changes };
      return current;
    },
  };
  return { engine, updates };
}

// ── runProposalMaterialization (orchestrator) ────────────────

describe("runProposalMaterialization — guards", () => {
  test("non-draft proposal → not_draft; provider NOT called, nothing written", async () => {
    const proposal = makeProposal({ status: "approved" });
    const { engine, updates } = makeEngine(proposal);
    const { provider, calls } = makeProvider();

    const outcome = await runProposalMaterialization(proposal.id, {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("not_draft");
    if (outcome.kind === "not_draft") expect(outcome.status).toBe("approved");
    expect(calls.count).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test("missing proposal → not_found; provider NOT called", async () => {
    const { engine } = makeEngine(undefined);
    const { provider, calls } = makeProvider();

    const outcome = await runProposalMaterialization("nope", {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("not_found");
    expect(calls.count).toBe(0);
  });
});

describe("runProposalMaterialization — happy path", () => {
  test("generates source, writes it back onto the draft, returns outcomes", async () => {
    const proposal = makeProposal();
    const { engine, updates } = makeEngine(proposal);
    const { provider, calls } = makeProvider();

    const outcome = await runProposalMaterialization(proposal.id, {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.allMaterialized).toBe(true);
      expect(outcome.outcomes[0]?.status).toBe("materialized");
      expect(outcome.proposal.changes[0]?.generatedSource).toBe(GOOD);
    }
    expect(calls.count).toBe(1);
    // The candidate source was persisted back onto the draft via updateProposal.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.changes?.[0]?.generatedSource).toBe(GOOD);
    // Input proposal is never mutated.
    expect(proposal.changes[0]?.generatedSource).toBeUndefined();
  });

  test("engine returning no proposal from updateProposal → error (not a crash)", async () => {
    const proposal = makeProposal();
    const { provider } = makeProvider();
    // A custom engine whose updateProposal returns undefined instead of the row.
    const engine: MaterializeEngine = {
      getProposal: () => proposal,
      updateProposal: () => undefined as unknown as ProposalDefinition,
    };

    const outcome = await runProposalMaterialization(proposal.id, {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("no proposal");
  });

  test("provider throwing surfaces as error (caught, not leaked)", async () => {
    const proposal = makeProposal();
    const { engine, updates } = makeEngine(proposal);
    const { provider } = makeProvider({ throws: true });

    const outcome = await runProposalMaterialization(proposal.id, {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("model exploded");
    expect(updates).toHaveLength(0);
  });
});

// ── Endpoint: POST /api/proposals/:id/materialize ────────────

interface MaterializeJson {
  success: boolean;
  data?: {
    proposalId?: string;
    allMaterialized?: boolean;
    outcomes?: Array<{ changeName: string; status: string }>;
    proposal?: { changes?: ProposalChange[] };
  };
  error?: { message?: string; code?: string };
}

/** A permissive command layer so endpoint tests exercise the materialize logic. */
const PASS_COMMAND_LAYER = {
  execute: async () => ({ success: true, data: { skipped: true } }),
} as unknown as CommandLayer;

function mountTestApp(opts: {
  proposal?: ProposalDefinition;
  provider?: CodeGenerationProvider | null;
  commandLayer?: CommandLayer | null;
}): { app: Elysia; engine: MaterializeEngine; providerCalls: { count: number } } {
  const { engine } = makeEngine(opts.proposal);
  const built =
    opts.provider === undefined ? makeProvider() : { provider: opts.provider, calls: { count: 0 } };
  const app = new Elysia();
  mountProposalMaterializeAPI(app, {
    commandLayer:
      opts.commandLayer === undefined ? PASS_COMMAND_LAYER : (opts.commandLayer ?? undefined),
    engine,
    qualityGate: PASS_GATE,
    resolveProvider: () => (opts.provider === undefined ? built.provider : opts.provider),
  });
  return { app, engine, providerCalls: built.calls };
}

async function postMaterialize(
  app: Elysia,
  id: string,
): Promise<{ status: number; json: MaterializeJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${id}/materialize`, { method: "POST" }),
  );
  return { status: res.status, json: (await res.json()) as MaterializeJson };
}

describe("POST /api/proposals/:id/materialize", () => {
  test("draft → 200 with outcomes + generatedSource on the returned proposal", async () => {
    const proposal = makeProposal();
    const { app, providerCalls } = mountTestApp({ proposal });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.proposalId).toBe(proposal.id);
    expect(json.data?.allMaterialized).toBe(true);
    expect(json.data?.outcomes?.[0]?.status).toBe("materialized");
    expect(json.data?.proposal?.changes?.[0]?.generatedSource).toBe(GOOD);
    expect(providerCalls.count).toBe(1);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; provider NOT called", async () => {
    const proposal = makeProposal();
    const denying = {
      execute: async () => ({ success: false, data: { error: "not allowed" } }),
    } as unknown as CommandLayer;
    const { app, providerCalls } = mountTestApp({ proposal, commandLayer: denying });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    expect(providerCalls.count).toBe(0);
  });

  test("command layer absent → 503 (cannot authorize); provider NOT called", async () => {
    const proposal = makeProposal();
    const { app, providerCalls } = mountTestApp({ proposal, commandLayer: null });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("MATERIALIZE.NOT_CONFIGURED");
    expect(providerCalls.count).toBe(0);
  });

  test("AI provider not configured → 503 graceful envelope; engine untouched", async () => {
    const proposal = makeProposal();
    // resolveProvider returns null → not configured.
    const { app } = mountTestApp({ proposal, provider: null });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("MATERIALIZE.NOT_CONFIGURED");
  });

  test("non-draft proposal → 422; provider NOT called", async () => {
    const proposal = makeProposal({ status: "validated" });
    const { app, providerCalls } = mountTestApp({ proposal });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.message).toContain("draft");
    expect(providerCalls.count).toBe(0);
  });

  test("missing proposal → 404", async () => {
    const { app } = mountTestApp({ proposal: makeProposal() });
    const { status, json } = await postMaterialize(app, "nope");
    expect(status).toBe(404);
    expect(json.success).toBe(false);
  });

  test("generation failure → 500", async () => {
    const proposal = makeProposal();
    const throwing: CodeGenerationProvider = {
      async generateCode() {
        throw new Error("model exploded");
      },
    };
    const { app } = mountTestApp({ proposal, provider: throwing });
    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error?.message).toContain("model exploded");
  });
});

// ── Ontology-derived generation context ──────────────────────

const ONTOLOGY_MARKER = "ENTITY: order — Purchase order";

/**
 * Minimal fake ontology: only `toMarkdown()` is exercised here. The other methods
 * throw so any accidental reliance on them surfaces loudly rather than silently
 * returning empty data.
 */
function makeFakeOntology(markdown: string): OntologyRegistry {
  const unused = (): never => {
    throw new Error("OntologyRegistry method not expected in this test");
  };
  return {
    toMarkdown: () => markdown,
    describe: unused,
    listEntities: unused,
    searchEntities: unused,
    actionsFor: unused,
    rulesFor: unused,
    stateFor: unused,
    viewsFor: unused,
    flowsFor: unused,
    handlersFor: unused,
    relatedEntities: unused,
    entitiesImplementing: unused,
    toJSON: unused,
    searchByIntent: unused,
  } as unknown as OntologyRegistry;
}

/** Provider that records the `context` (2nd) argument of every generateCode call. */
function makeRecordingProvider(): {
  provider: CodeGenerationProvider;
  contexts: Array<string | undefined>;
} {
  const contexts: Array<string | undefined> = [];
  const provider: CodeGenerationProvider = {
    async generateCode(_prompt, context) {
      contexts.push(context);
      return GOOD;
    },
  };
  return { provider, contexts };
}

describe("POST /api/proposals/:id/materialize — context sourcing", () => {
  test("ontology (no explicit context) → provider receives the ontology summary", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const { provider, contexts } = makeRecordingProvider();
    const app = new Elysia();
    mountProposalMaterializeAPI(app, {
      commandLayer: PASS_COMMAND_LAYER,
      engine,
      qualityGate: PASS_GATE,
      ontology: makeFakeOntology(ONTOLOGY_MARKER),
      resolveProvider: () => provider,
    });

    const { status, json } = await postMaterialize(app, proposal.id);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(contexts).toHaveLength(1);
    // The generated context embeds the real ontology summary…
    expect(contexts[0]).toContain(ONTOLOGY_MARKER);
    // …prefixed with the project conventions preamble.
    expect(contexts[0]).toContain("defineAction()");
  });

  test("explicit context wins over the ontology (verbatim, no summary)", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const { provider, contexts } = makeRecordingProvider();
    const explicit = "MY EXPLICIT CONTEXT";
    const app = new Elysia();
    mountProposalMaterializeAPI(app, {
      commandLayer: PASS_COMMAND_LAYER,
      engine,
      qualityGate: PASS_GATE,
      context: explicit,
      ontology: makeFakeOntology(ONTOLOGY_MARKER),
      resolveProvider: () => provider,
    });

    const { status } = await postMaterialize(app, proposal.id);

    expect(status).toBe(200);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toBe(explicit);
    expect(contexts[0]).not.toContain(ONTOLOGY_MARKER);
  });

  test("ontology summary over the cap is truncated with a marker", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const { provider, contexts } = makeRecordingProvider();
    // 20k of filler well past the ~12k cap.
    const huge = `${ONTOLOGY_MARKER}\n${"x".repeat(20_000)}`;
    const app = new Elysia();
    mountProposalMaterializeAPI(app, {
      commandLayer: PASS_COMMAND_LAYER,
      engine,
      qualityGate: PASS_GATE,
      ontology: makeFakeOntology(huge),
      resolveProvider: () => provider,
    });

    const { status } = await postMaterialize(app, proposal.id);

    expect(status).toBe(200);
    expect(contexts[0]).toContain("(truncated)");
    // Preamble + capped summary stays bounded (well under the raw 20k input).
    expect((contexts[0] ?? "").length).toBeLessThan(13_000);
  });
});
