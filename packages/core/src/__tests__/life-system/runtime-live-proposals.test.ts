/**
 * Live evolution-cycle proposal wiring (Spec 55 §7) — G1 regression guard.
 *
 * The `linch dev` boot path constructs the evolution runtime via
 * `createEvolutionRuntime({...})`. Before G1 it passed only `sensors` + `query`,
 * so `ontology` fell back to an empty stub and `translatorRegistry` was omitted —
 * meaning the structural check had no input AND no translator, so the cycle
 * dead-ended at Insight and `result.proposals` was always `[]`.
 *
 * This test reconstructs the runtime EXACTLY as dev-wiring now wires it (the
 * same four options: an ontology carrying a view-less entity, the default
 * translator registry, the `proposalCapability` label, and the dedup+impact
 * pre-analysis pipeline) and asserts the loop now emits an analyzed proposal.
 *
 * dev-wiring itself builds a full server context (too heavy to invoke here), so
 * this focuses on the runtime composition contract that wiring depends on.
 *
 * SAFETY: this asserts proposals appear as DATA on the cycle result only. The
 * runtime exposes no committer/file-writer surface, so no graduation can occur
 * by construction — see the explicit assertion at the end.
 */

import { describe, expect, it } from "bun:test";
import {
  createDedupAnalyzer,
  createDefaultInsightTranslatorRegistry,
  createImpactAnalyzer,
  createPreAnalysisPipeline,
} from "../../life-system";
import { defineSensor } from "../../life-system/define-sensor";
import type {
  ImpactDataProvider,
  PendingProposalStore,
} from "../../life-system/proposal-preanalysis/types";
import { createEvolutionRuntime } from "../../life-system/runtime";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import type { SensorContext, SensorSignal } from "../../types/life-system";
import type { ProposalDefinition } from "../../types/proposal";

const FROZEN_NOW = new Date("2026-06-06T00:00:00.000Z");

/**
 * Tiny in-process ontology carrying one entity (`metric_sample`) that has NO
 * view — the trigger for the `schema_no_view` structural issue → insight →
 * `add_view` proposal pipeline. No-op stubs satisfy the rest of the contract.
 */
function createViewlessOntology(): OntologyRegistry {
  const schemas: Record<string, Partial<EntityDescriptor>> = {
    metric_sample: {
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

/** Single-emit sensor so one `runCycle()` has exactly one signal to ingest. */
function createOneShotSensor() {
  let emitted = false;
  return defineSensor({
    name: "metric_sample_tick",
    source: "server",
    entity: "metric_sample",
    async detect(ctx: SensorContext): Promise<SensorSignal | null> {
      if (emitted) return null;
      emitted = true;
      return {
        sensor: "metric_sample_tick",
        source: "server",
        timestamp: ctx.timestamp,
        value: 42,
        baseline: 40,
        deviation: 0.05,
        confidence: 0.95,
        context: { entity: "metric_sample", metric: "value", tenantId: "dev" },
      };
    },
  });
}

/** Empty stores mirroring dev-wiring's stubs — the pipeline still runs. */
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

describe("createEvolutionRuntime — live proposal wiring (G1)", () => {
  it("emits an analyzed add_view proposal for a view-less entity (matches dev-wiring options)", async () => {
    // Construct the runtime with the SAME option shape dev-wiring now uses:
    // ontology + translatorRegistry + proposalCapability + preanalysis pipeline.
    const runtime = createEvolutionRuntime({
      sensors: [createOneShotSensor()],
      ontology: createViewlessOntology(),
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      proposalCapability: "linch-dev",
      proposalPreAnalysisPipeline: createPreAnalysisPipeline({
        analyzers: [
          createDedupAnalyzer({ store: createEmptyPendingProposalStore() }),
          createImpactAnalyzer({ dataProvider: createEmptyImpactDataProvider() }),
        ],
      }),
    });

    const result = await runtime.evolutionCycle.runCycle({ timestamp: FROZEN_NOW });

    // Insight: the view-less entity surfaced a structural insight.
    const structural = result.newInsights.filter((i) => i.type === "structural");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.entity).toBe("metric_sample");

    // Proposal: the default translator produced at least one add_view proposal.
    expect(result.proposals.length).toBeGreaterThan(0);
    const addView = result.proposals.find((p) =>
      p.changes.some((c) => c.target === "view" && c.operation === "create"),
    );
    expect(addView).toBeDefined();
    if (!addView) throw new Error("expected an add_view proposal");
    expect(addView.capability).toBe("linch-dev");
    // The cycle timestamp propagates to the proposal stamp.
    expect(addView.createdAt.getTime()).toBe(FROZEN_NOW.getTime());

    // Pre-analysis: the pipeline ran — proposalAnalyses is populated 1:1.
    expect(result.proposalAnalyses).toHaveLength(result.proposals.length);
    expect(result.proposalAnalyses.length).toBeGreaterThan(0);
    const analysis = result.proposalAnalyses[0];
    if (!analysis) throw new Error("expected a pre-analysis envelope");
    expect(analysis.stages.dedup?.status).toBe("ok");
    expect(analysis.stages.impact?.status).toBe("ok");
    expect(analysis.allStagesSucceeded).toBe(true);

    // SAFETY (by construction): the runtime surface carries NO graduation hook —
    // no committer, file-writer, or git path. Proposals are pure cycle DATA.
    const runtimeKeys = Object.keys(runtime);
    expect(runtimeKeys).toEqual([
      "signalBus",
      "evolutionCycle",
      "insightEngine",
      "awarenessEngine",
    ]);
    expect(runtimeKeys).not.toContain("committer");
    expect(runtimeKeys).not.toContain("fileWriter");
    expect((runtime as unknown as { gitCommitter?: unknown }).gitCommitter).toBeUndefined();
  });

  it("emits NO proposals when ontology + translator are omitted (pre-G1 dead-end regression guard)", async () => {
    // The exact pre-G1 dev-wiring call shape: only sensors + (here) no query.
    // Without ontology the structural check has no input; without a translator
    // registry nothing translates — so the cycle dead-ends at Insight.
    const runtime = createEvolutionRuntime({
      sensors: [createOneShotSensor()],
    });

    const result = await runtime.evolutionCycle.runCycle({ timestamp: FROZEN_NOW });

    expect(result.proposals).toEqual([]);
    expect(result.proposalAnalyses).toEqual([]);
  });
});
