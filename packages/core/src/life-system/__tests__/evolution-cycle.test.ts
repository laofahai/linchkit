import { describe, expect, test } from "bun:test";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import type { Insight, SensorSignal } from "../../types/life-system";
import { createAttentionBudget } from "../attention-budget";
import { createAwarenessEngine } from "../awareness-engine";
import { defineSensor } from "../define-sensor";
import { createEvolutionCycle } from "../evolution-cycle";
import { InMemoryMemoryStore } from "../in-memory-memory-store";
import {
  createDefaultInsightTranslatorRegistry,
  createInsightTranslatorRegistry,
} from "../insight-to-proposal";
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

describe("EvolutionCycle", () => {
  function setup(opts?: {
    schemas?: Record<string, Partial<EntityDescriptor>>;
    sensorSignals?: SensorSignal[];
  }) {
    const schemas = opts?.schemas ?? {
      Order: { views: [{ name: "list" } as never], actions: [] },
    };
    const signalBus = createSignalBus();
    const store = new InMemoryMemoryStore();
    const memoryEngine = new MemoryEngine({ store, driftThreshold: 0.3 });
    const ontology = makeOntology(schemas);
    const awareness = createAwarenessEngine({ ontology });

    // Register a test sensor that returns provided signals
    const signals = opts?.sensorSignals ?? [];
    let callCount = 0;
    signalBus.registerSensor(
      defineSensor({
        name: "test_sensor",
        source: "api",
        detect: async () => {
          if (callCount < signals.length) {
            return signals[callCount++] ?? null;
          }
          return null;
        },
      }),
    );

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      insightPromotion: { minOccurrences: 2, minDistinctContexts: 1, minConfidence: 0.5 },
    });

    return { cycle, signalBus, memoryEngine, store };
  }

  test("empty cycle returns zeros", async () => {
    const { cycle } = setup();
    const result = await cycle.runCycle();

    expect(result.signalsCollected).toBe(0);
    expect(result.driftsDetected).toBe(0);
    expect(result.newInsights).toHaveLength(0);
    expect(result.totalInsights).toBe(0);
  });

  test("collects signals and ingests into memory", async () => {
    const signal: SensorSignal = {
      sensor: "test_sensor",
      source: "api",
      timestamp: new Date(),
      value: 100,
      baseline: 50,
      deviation: 0.5,
      confidence: 0.9,
      context: { entity: "order", metric: "count" },
    };

    const { cycle, store } = setup({ sensorSignals: [signal] });
    const result = await cycle.runCycle();

    expect(result.signalsCollected).toBe(1);
    expect(store.signalCount).toBe(1);
  });

  test("detects drift and records candidates", async () => {
    // First seed a baseline so drift can be detected
    const store = new InMemoryMemoryStore();
    await store.updateBaseline({
      entity: "order",
      metric: "value",
      value: 50,
      calculatedAt: new Date(),
    });

    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({ store, driftThreshold: 0.3 });
    const ontology = makeOntology({ Order: { views: [{ name: "list" } as never], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });

    // Signal with value far from baseline (100 vs 50 = 100% deviation)
    const driftSignal: SensorSignal = {
      sensor: "test_sensor",
      source: "api",
      timestamp: new Date(),
      value: 100,
      baseline: 50,
      deviation: 0.5,
      confidence: 0.9,
      context: { entity: "order", metric: "value", tenantId: "t1" },
    };

    let emitted = false;
    signalBus.registerSensor(
      defineSensor({
        name: "test_sensor",
        source: "api",
        detect: async () => {
          if (!emitted) {
            emitted = true;
            return driftSignal;
          }
          return null;
        },
      }),
    );

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      insightPromotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
    });

    const result = await cycle.runCycle();
    expect(result.driftsDetected).toBe(1);
    // With minOccurrences=1, should promote immediately
    expect(result.newInsights.length).toBeGreaterThanOrEqual(1);
    expect(result.newInsights.some((i) => i.type === "anomaly")).toBe(true);
  });

  test("generates structural insights on first cycle", async () => {
    const { cycle } = setup({
      schemas: { Order: { views: [], actions: [] } }, // No views → structural issue
    });

    const result = await cycle.runCycle();

    expect(result.newInsights.some((i) => i.type === "structural")).toBe(true);
    expect(result.totalInsights).toBeGreaterThanOrEqual(1);
  });

  test("feeds signals into awareness usage graph", async () => {
    const signal: SensorSignal = {
      sensor: "test_sensor",
      source: "api",
      timestamp: new Date(),
      value: 10,
      baseline: 10,
      deviation: 0,
      confidence: 0.9,
      context: { entity: "order" },
    };

    const { cycle } = setup({ sensorSignals: [signal] });
    await cycle.runCycle();

    const importance = cycle.awarenessEngine.usageGraph.getImportance("entity", "order");
    expect(importance).toBeGreaterThan(0);
  });

  test("multiple cycles accumulate insights", async () => {
    const store = new InMemoryMemoryStore();
    await store.updateBaseline({
      entity: "order",
      metric: "value",
      value: 50,
      calculatedAt: new Date(),
    });

    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({ store, driftThreshold: 0.3 });
    const ontology = makeOntology({ Order: { views: [{ name: "list" } as never], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });

    let callIdx = 0;
    const driftSignals: SensorSignal[] = [
      {
        sensor: "test_sensor",
        source: "api",
        timestamp: new Date(),
        value: 100,
        baseline: 50,
        deviation: 0.5,
        confidence: 0.9,
        context: { entity: "order", metric: "value", tenantId: "t1" },
      },
      {
        sensor: "test_sensor",
        source: "api",
        timestamp: new Date(),
        value: 250,
        baseline: 50,
        deviation: 0.8,
        confidence: 0.85,
        context: { entity: "order", metric: "value", tenantId: "t2" },
      },
    ];

    signalBus.registerSensor(
      defineSensor({
        name: "test_sensor",
        source: "api",
        detect: async () => {
          if (callIdx < driftSignals.length) {
            return driftSignals[callIdx++] ?? null;
          }
          return null;
        },
      }),
    );

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      insightPromotion: { minOccurrences: 2, minDistinctContexts: 2, minConfidence: 0.5 },
    });

    // Cycle 1: one drift, not enough for promotion
    const r1 = await cycle.runCycle();
    expect(r1.driftsDetected).toBe(1);
    const driftInsights1 = r1.newInsights.filter((i) => i.type === "anomaly");
    expect(driftInsights1).toHaveLength(0);

    // Cycle 2: second drift with different context → should promote
    const r2 = await cycle.runCycle();
    expect(r2.driftsDetected).toBe(1);
    const driftInsights2 = r2.newInsights.filter((i) => i.type === "anomaly");
    expect(driftInsights2).toHaveLength(1);
    expect(r2.totalInsights).toBeGreaterThanOrEqual(1);
  });

  test("exposes insightEngine and awarenessEngine", () => {
    const { cycle } = setup();
    expect(cycle.insightEngine).toBeDefined();
    expect(cycle.awarenessEngine).toBeDefined();
    expect(cycle.awarenessEngine.usageGraph).toBeDefined();
  });

  // ── Slice 3: Insight → Proposal wiring (Spec 55 §7) ──────

  test("without translator registry: returns empty proposals (regression)", async () => {
    // Entity with no view → structural insight surfaces. Without a registry
    // the cycle must NOT emit any proposals — pre-Slice-3 behavior preserved.
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({ Order: { views: [], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });
    const cycle = createEvolutionCycle({ signalBus, memoryEngine, awareness });

    const result = await cycle.runCycle();

    expect(result.newInsights.some((i) => i.type === "structural")).toBe(true);
    expect(result.proposals).toEqual([]);
  });

  test("with default translator: structural schema_no_view surfaces a proposal", async () => {
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    // Order has no views and one field so the translator can enrich the
    // default view from the ontology.
    const ontology = makeOntology({
      Order: { views: [], actions: [], fields: { id: { type: "string" } } as never },
    });
    const awareness = createAwarenessEngine({ ontology });
    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      ontology,
      proposalCapability: "test-cap",
    });

    // Pin the cycle to a known signal-time so we can assert the proposal's
    // createdAt was stamped from sensorContext.timestamp (not from the
    // wall clock).
    const cycleTimestamp = new Date("2026-05-08T00:00:00.000Z");
    const result = await cycle.runCycle({ timestamp: cycleTimestamp });

    expect(result.newInsights.some((i) => i.type === "structural")).toBe(true);
    expect(result.proposals).toHaveLength(1);

    const proposal = result.proposals[0];
    if (!proposal) throw new Error("expected proposal");
    expect(proposal.capability).toBe("test-cap");
    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0];
    if (!change) throw new Error("expected change");
    expect(change.target).toBe("view");
    expect(change.operation).toBe("create");
    // Trace: proposal description echoes insight summary.
    const sourceInsight = result.newInsights.find((i) => i.type === "structural");
    if (!sourceInsight) throw new Error("expected structural insight");
    expect(proposal.description).toBe(sourceInsight.summary);
    // Proposal createdAt inherits sensorContext.timestamp so historical
    // replay and fixed-clock tests reproduce identical proposals.
    expect(proposal.createdAt.getTime()).toBe(cycleTimestamp.getTime());
    expect(proposal.updatedAt.getTime()).toBe(cycleTimestamp.getTime());
  });

  test("budget caps surfaced insights AND proposals match surfaced only", async () => {
    // Three entities each missing a view → three structural insights. Cap
    // the budget at maxInsightsPerCycle=2 and assert: exactly two insights
    // surface this cycle, exactly two proposals are emitted, and the
    // proposals correspond 1:1 to the surfaced (not budget-dropped) insights.
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({
      Alpha: { views: [], actions: [] },
      Beta: { views: [], actions: [] },
      Gamma: { views: [], actions: [] },
    });
    const cappedBudget = createAttentionBudget({ maxInsightsPerCycle: 2 });
    const awareness = createAwarenessEngine({
      ontology,
      attentionBudget: cappedBudget,
    });
    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      // ontology intentionally omitted — translator falls back to empty
      // field list, keeping this test focused on the budget/proposal-pairing
      // contract instead of view enrichment.
    });

    const result = await cycle.runCycle();

    expect(result.newInsights).toHaveLength(2);
    expect(result.proposals).toHaveLength(2);

    // Every emitted proposal must reference one of the surfaced insights'
    // entities — the budget-dropped insight must not have produced a proposal.
    const surfacedEntities = new Set(result.newInsights.map((i) => i.entity));
    for (const proposal of result.proposals) {
      const change = proposal.changes[0];
      if (!change) throw new Error("expected change");
      const view = change.definition as { entity: string };
      expect(surfacedEntities.has(view.entity)).toBe(true);
    }

    // Total promoted insights still 3 — the dropped one stays in the
    // unsurfaced pool for a future cycle (InsightEngine internal contract).
    expect(result.totalInsights).toBe(3);
  });

  test("translator that declines: insight surfaces, no proposal emitted", async () => {
    const signalBus = createSignalBus();
    const memoryEngine = new MemoryEngine({
      store: new InMemoryMemoryStore(),
      driftThreshold: 0.3,
    });
    const ontology = makeOntology({ Order: { views: [], actions: [] } });
    const awareness = createAwarenessEngine({ ontology });

    // A registry whose lone translator always declines. We register it on
    // the structural:schema_no_view key so the dispatcher reaches it.
    const decliningRegistry = createInsightTranslatorRegistry();
    let declineCalls = 0;
    decliningRegistry.register("structural:schema_no_view", (_insight: Insight) => {
      declineCalls++;
      return null;
    });

    const cycle = createEvolutionCycle({
      signalBus,
      memoryEngine,
      awareness,
      translatorRegistry: decliningRegistry,
    });

    const result = await cycle.runCycle();

    expect(result.newInsights.some((i) => i.type === "structural")).toBe(true);
    expect(declineCalls).toBeGreaterThanOrEqual(1);
    expect(result.proposals).toEqual([]);
  });
});

// ── Slice 4: Proposal pre-analysis wiring (Spec 55 §7.3) ─────

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
