import { describe, expect, test } from "bun:test";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import { createAwarenessEngine } from "../awareness-engine";
import { createEvolutionCycle } from "../evolution-cycle";
import { InMemoryMemoryStore } from "../in-memory-memory-store";
import { createDefaultInsightTranslatorRegistry } from "../insight-to-proposal";
import { MemoryEngine } from "../memory-engine";
import { createPreAnalysisPipeline } from "../proposal-preanalysis";
import type { DedupResult, PreAnalyzer } from "../proposal-preanalysis/types";
import { createSignalBus } from "../signal-bus";

function makeOntology(schemas: Record<string, Partial<EntityDescriptor>>): OntologyRegistry {
  return {
    describe(name: string) {
      return schemas[name] as EntityDescriptor | undefined;
    },
    listEntities() {
      return Object.keys(schemas);
    },
  } as unknown as OntologyRegistry;
}

describe("EvolutionCycle pre-analysis wiring (Spec 55 §7.3)", () => {
  test("without pipeline: proposalAnalyses is empty (zero regression)", async () => {
    // Cycle WITHOUT proposalPreAnalysisPipeline but WITH a translator
    // registry + an entity missing a view → exactly one proposal is emitted.
    // The new field must default to [] so callers untouched by #280 see
    // identical behavior.
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({ Order: { views: [], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      // ontology intentionally omitted on the cycle so the default translator
      // falls back to empty view fields — keeps this test focused on the
      // proposalAnalyses default ([]) rather than view enrichment.
    });

    const result = await cycle.runCycle();

    expect(result.proposals).toHaveLength(1);
    expect(result.proposalAnalyses).toEqual([]);
  });

  test("with pipeline: 1:1 indexing + per-proposal correlation", async () => {
    // Two entities each missing a view → two proposals. A fake dedup analyzer
    // returns a fixed DedupResult; the pipeline wraps it in an envelope.
    // Assertions: analyses length matches proposals, indexes correlate by id,
    // and the envelope's data is the analyzer's return value.
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({
      Alpha: { views: [], actions: [] },
      Beta: { views: [], actions: [] },
    });
    const awareness = createAwarenessEngine({ ontology });

    const fakeDedupResult: DedupResult = {
      similar: [],
      exactMatch: null,
      payloadHash: "test",
    };
    const fakeAnalyzer: PreAnalyzer<"dedup", DedupResult> = {
      stage: "dedup",
      name: "test_dedup",
      analyze: async () => fakeDedupResult,
    };
    const pipeline = createPreAnalysisPipeline({ analyzers: [fakeAnalyzer] });

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      proposalPreAnalysisPipeline: pipeline,
    });

    const result = await cycle.runCycle();

    expect(result.proposals).toHaveLength(2);
    expect(result.proposalAnalyses).toHaveLength(2);

    // Index alignment: analyses[i] corresponds to proposals[i].
    const proposal0 = result.proposals[0];
    const proposal1 = result.proposals[1];
    const analysis0 = result.proposalAnalyses[0];
    const analysis1 = result.proposalAnalyses[1];
    if (!proposal0 || !proposal1 || !analysis0 || !analysis1) {
      throw new Error("expected proposals and analyses present at indexes 0 and 1");
    }
    expect(analysis0.proposalId).toBe(proposal0.id);
    expect(analysis1.proposalId).toBe(proposal1.id);

    // Each analysis carries the fake dedup envelope with status "ok".
    expect(analysis0.stages.dedup?.status).toBe("ok");
    expect(analysis0.stages.dedup?.data).toEqual(fakeDedupResult);
    expect(analysis1.stages.dedup?.status).toBe("ok");
    expect(analysis1.stages.dedup?.data).toEqual(fakeDedupResult);
  });

  test("zero proposals + pipeline supplied: pipeline is skipped (analyses [])", async () => {
    // No translator registry → 0 proposals even though a structural insight
    // surfaces. The pipeline must NOT be called when there are no proposals
    // to analyze (skip the Promise.all on the empty array).
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({ Order: { views: [], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });

    let analyzeCalls = 0;
    const spyingAnalyzer: PreAnalyzer<"dedup", DedupResult> = {
      stage: "dedup",
      name: "spy_dedup",
      analyze: async () => {
        analyzeCalls++;
        return { similar: [], exactMatch: null, payloadHash: "spy" };
      },
    };
    const pipeline = createPreAnalysisPipeline({ analyzers: [spyingAnalyzer] });

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      // translatorRegistry intentionally omitted → 0 proposals
      proposalPreAnalysisPipeline: pipeline,
    });

    const result = await cycle.runCycle();

    expect(result.newInsights.some((i) => i.type === "structural")).toBe(true);
    expect(result.proposals).toEqual([]);
    expect(result.proposalAnalyses).toEqual([]);
    // Critical: pipeline.analyze must never have been called when there are
    // no proposals — guards the `proposals.length > 0` short-circuit.
    expect(analyzeCalls).toBe(0);
  });
});
