/**
 * Full Sense → Memory → Awareness → Insight → Proposal cycle demo (Spec 55).
 *
 * Wires every life-system layer end-to-end so a single `runFullCycleDemo()`
 * call produces an observable trace of the complete evolution loop:
 *
 *   1. Sense — `tick_sensor` is registered with the runtime's SignalBus and
 *      emits a synthetic `SensorSignal` on each cycle.
 *
 *   2. Memory — runtime's MemoryEngine ingests the signal into its default
 *      InMemoryMemoryStore and (re)computes the entity baseline.
 *
 *   3. Awareness — runtime's AwarenessEngine consumes the signal, runs the
 *      structural check, and surfaces a `schema_no_view` issue because the
 *      bundled ontology contains an entity with NO view.
 *
 *   4. Insight — runtime's InsightEngine promotes the structural issue into
 *      an `Insight` immediately (structural insights bypass drift-promotion
 *      rules — Spec 55 §6.3).
 *
 *   5. Proposal — `createDefaultInsightTranslatorRegistry()` translates the
 *      surfaced insight into a `ProposalDefinition` via the deterministic
 *      `structural:schema_no_view` translator.
 *
 *   6. Pre-analysis — every emitted proposal is fed through a
 *      `createPreAnalysisPipeline({ analyzers: [dedup, impact] })` so the
 *      reviewer envelope (similar count, affectedRecordCount, durations,
 *      allStagesSucceeded) is attached for inspection.
 *
 * The cycle is wired through {@link createEvolutionRuntime} — the same
 * factory production code uses — rather than reaching into core internals,
 * so the demo doubles as a reference for capability authors.
 *
 * Returns a {@link FullCycleDemoResult} containing the cycle's
 * {@link EvolutionCycleResult} plus the per-proposal pre-analysis envelopes.
 *
 * The demo's job is observable evolution loop, per Spec 00a §2.3 — a reader
 * running `bun run demo` should see "the system observed → remembered →
 * understood → derived insights → proposed changes → pre-analyzed them" in
 * one execution.
 *
 * In-memory dependencies are intentionally minimal:
 *   - `PendingProposalStore.listPending()` returns `[]` (no prior proposals)
 *   - `ImpactDataProvider.countRecords()` / `sampleRecordIds()` return
 *     `0`/`[]`. The bundled demo entity is fictional, so the impact stage
 *     proves the pipeline executed rather than producing a real-world hit.
 */

import {
  createDedupAnalyzer,
  createDefaultInsightTranslatorRegistry,
  createEvolutionRuntime,
  createImpactAnalyzer,
  createPreAnalysisPipeline,
  defineSensor,
  type EntityDescriptor,
  type EvolutionCycleResult,
  type ImpactDataProvider,
  type OntologyRegistry,
  type PendingProposalStore,
  type PreAnalysisPipeline,
  type ProposalDefinition,
  type ProposalPreAnalysisResult,
  type SensorContext,
  type SensorSignal,
} from "@linchkit/core";

/** Per-proposal pre-analysis envelope returned alongside the cycle result. */
export interface ProposalAnalysis {
  proposal: ProposalDefinition;
  preAnalysis: ProposalPreAnalysisResult;
}

/** Aggregate output from {@link runFullCycleDemo}. */
export interface FullCycleDemoResult {
  cycle: EvolutionCycleResult;
  proposalAnalyses: ProposalAnalysis[];
}

/**
 * Build a tiny in-process {@link OntologyRegistry} carrying exactly the
 * entities the demo needs. `synthetic_metric` has NO views — the trigger for
 * the `schema_no_view` structural issue → insight → proposal pipeline.
 *
 * The full {@link OntologyRegistry} contract is satisfied with no-op stubs
 * for the methods AwarenessEngine and InsightTranslator don't currently
 * exercise. This keeps the demo as a robust reference for capability
 * authors — adding a future structural check that calls, say,
 * `actionsFor()` will yield empty results instead of "is not a function"
 * runtime errors.
 */
function createDemoOntology(): OntologyRegistry {
  const schemas: Record<string, Partial<EntityDescriptor>> = {
    // Entity with no views — fires the schema_no_view structural insight.
    synthetic_metric: {
      views: [],
      actions: [],
      // Field map lets the schemaNoViewTranslator enrich the default list
      // view with real columns (id, value) instead of an empty stub.
      fields: {
        id: { type: "string" },
        value: { type: "number" },
      } as EntityDescriptor["fields"],
    },
  };

  return {
    describe: (entityName) => schemas[entityName] as EntityDescriptor | undefined,
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
  };
}

/**
 * No-op pending-proposal store. Always returns an empty list so the dedup
 * analyzer reports `similar: []` / `exactMatch: null` — the demo's goal is
 * to prove the stage ran, not to engineer a dedup hit.
 */
function createEmptyPendingProposalStore(): PendingProposalStore {
  return {
    async listPending(): Promise<ProposalDefinition[]> {
      return [];
    },
  };
}

/**
 * No-op impact data provider. Returns zero counts and empty samples so the
 * impact analyzer reports `affectedRecordCount: 0` for any data-target
 * change. The bundled proposal targets a `view` (code-only) so the analyzer
 * short-circuits with `reason: "not-a-data-change"` regardless — but the
 * provider must still satisfy the {@link ImpactDataProvider} contract.
 */
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

/** Construct the synthetic sensor used by the demo's SignalBus run. */
function createTickSensor() {
  let emitted = false;
  return defineSensor({
    name: "tick_sensor",
    source: "server",
    entity: "synthetic_metric",
    async detect(ctx: SensorContext): Promise<SensorSignal | null> {
      // Single-emit so a `runCycle()` call has exactly one signal to ingest.
      if (emitted) return null;
      emitted = true;
      return {
        sensor: "tick_sensor",
        source: "server",
        timestamp: ctx.timestamp,
        value: 42,
        baseline: 40,
        deviation: 0.05,
        confidence: 0.95,
        context: { entity: "synthetic_metric", metric: "value", tenantId: "demo" },
      };
    },
  });
}

export interface RunFullCycleDemoOptions {
  /** Override the cycle's sensor context timestamp (tests). */
  timestamp?: Date;
}

/**
 * Run the full evolution loop once and return the observable result.
 *
 * Side-effect-free: the runtime is created fresh per call so multiple demo
 * runs don't interfere.
 */
export async function runFullCycleDemo(
  options: RunFullCycleDemoOptions = {},
): Promise<FullCycleDemoResult> {
  // 1–5. Build the runtime — same factory production wiring uses. The
  // runtime constructs SignalBus, MemoryEngine (with InMemoryMemoryStore by
  // default), AwarenessEngine, and InsightEngine internally; the demo only
  // supplies the policy bits (sensors, ontology, translator registry).
  const runtime = createEvolutionRuntime({
    sensors: [createTickSensor()],
    ontology: createDemoOntology(),
    translatorRegistry: createDefaultInsightTranslatorRegistry(),
    proposalCapability: "cap-life-demo",
  });

  const result = await runtime.evolutionCycle.runCycle({
    timestamp: options.timestamp ?? new Date(),
  });

  // 6. Pre-analysis — fan every emitted proposal through the dedup + impact
  // pipeline. The pipeline is constructed manually here (rather than via
  // the runtime's optional `proposalPreAnalysisPipeline` option) so the
  // demo stays compatible regardless of which Spec 55 §7.3 wiring slice
  // has shipped.
  const preAnalysisPipeline: PreAnalysisPipeline = createPreAnalysisPipeline({
    analyzers: [
      createDedupAnalyzer({ store: createEmptyPendingProposalStore() }),
      createImpactAnalyzer({ dataProvider: createEmptyImpactDataProvider() }),
    ],
  });

  const proposalAnalyses: ProposalAnalysis[] = [];
  for (const proposal of result.proposals) {
    const preAnalysis = await preAnalysisPipeline.analyze(proposal);
    proposalAnalyses.push({ proposal, preAnalysis });
  }

  return { cycle: result, proposalAnalyses };
}
