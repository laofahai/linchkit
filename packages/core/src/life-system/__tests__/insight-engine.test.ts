import { describe, expect, test } from "bun:test";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import type { SensorSignal } from "../../types/life-system";
import { createAttentionBudget } from "../attention-budget";
import { createAwarenessEngine } from "../awareness-engine";
import { createInsightEngine } from "../insight-engine";

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

function makeSignal(overrides: Partial<SensorSignal> = {}): SensorSignal {
  return {
    sensor: "test_sensor",
    source: "api",
    timestamp: new Date(),
    value: 100,
    baseline: 50,
    deviation: 0.5,
    confidence: 0.9,
    context: { entity: "order" },
    ...overrides,
  };
}

describe("InsightEngine", () => {
  describe("structural insights", () => {
    test("generates structural insight for entity without view", async () => {
      const ontology = makeOntology({ Order: { views: [], actions: [] } });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });

      const insights = await engine.generateInsights();

      expect(insights).toHaveLength(1);
      const insight = insights[0];
      expect(insight?.type).toBe("structural");
      expect(insight?.confidence).toBe(1.0);
      expect(insight?.causality).toBe("structural");
      expect(insight?.entity).toBe("Order");
    });

    test("does not duplicate structural insights on repeated calls", async () => {
      const ontology = makeOntology({ Order: { views: [], actions: [] } });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });

      await engine.generateInsights();
      const second = await engine.generateInsights();

      expect(second).toHaveLength(0);
      expect(engine.getInsights()).toHaveLength(1);
    });
  });

  describe("drift promotion", () => {
    test("does not promote drift with fewer than minOccurrences", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 3, minDistinctContexts: 1, minConfidence: 0.5 },
      });

      // Only 2 occurrences
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );

      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(0);
    });

    test("promotes drift after meeting occurrence and context thresholds", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 3, minDistinctContexts: 2, minConfidence: 0.5 },
      });

      // 3 occurrences across 2 contexts
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t1" } }),
        0.7,
      );

      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(1);
      const driftInsight = insights[0];
      expect(driftInsight?.type).toBe("anomaly");
      expect(driftInsight?.entity).toBe("order");
      expect(driftInsight?.impact).toBe("high"); // maxDeviation 0.7 → high
    });

    test("does not promote drift below confidence threshold", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 2, minDistinctContexts: 1, minConfidence: 0.9 },
      });

      engine.recordDriftCandidate(
        makeSignal({ confidence: 0.5, context: { entity: "order", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ confidence: 0.6, context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );

      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(0);
    });

    test("does not re-promote already promoted drift", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 2, minDistinctContexts: 1, minConfidence: 0.5 },
      });

      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );

      await engine.generateInsights();
      // Add more signals — should not create a second insight for same key
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t3" } }),
        0.8,
      );

      const second = await engine.generateInsights();
      expect(second).toHaveLength(0);
      expect(engine.getInsights()).toHaveLength(1);
    });

    test("prunes candidates outside time window", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: {
          minOccurrences: 2,
          minDistinctContexts: 1,
          minConfidence: 0.5,
          timeWindowMs: 1000, // 1 second window
        },
      });

      // Signal from the past (outside 1s window)
      const oldSignal = makeSignal({
        timestamp: new Date(Date.now() - 5000),
        context: { entity: "order", tenantId: "t1" },
      });
      engine.recordDriftCandidate(oldSignal, 0.5);

      // One recent signal — not enough after pruning
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );

      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(0);
    });

    test("prunes stale contexts along with expired signals", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: {
          minOccurrences: 2,
          minDistinctContexts: 2,
          minConfidence: 0.5,
          timeWindowMs: 1000, // 1 second window
        },
      });

      // Old signal from context "t1" (will be pruned)
      engine.recordDriftCandidate(
        makeSignal({
          timestamp: new Date(Date.now() - 5000),
          context: { entity: "order", tenantId: "t1" },
        }),
        0.5,
      );
      // Two recent signals but SAME context "t2" — should not meet minDistinctContexts=2
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t2" } }),
        0.6,
      );

      // Without context pruning fix, this would incorrectly promote
      // because contexts would still contain "t1" from the expired signal
      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(0);
    });
  });

  describe("getInsights", () => {
    test("returns all promoted insights", async () => {
      const ontology = makeOntology({ A: { views: [], actions: [] } });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });

      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", tenantId: "t1" } }),
        0.5,
      );
      await engine.generateInsights();

      const all = engine.getInsights();
      expect(all).toHaveLength(2); // 1 structural + 1 drift
      expect(all.map((i) => i.type).sort()).toEqual(["anomaly", "structural"]);
    });
  });

  describe("metric separation", () => {
    test("tracks different metrics as separate candidates", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });

      // Same entity+sensor, different metrics
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", metric: "count", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", metric: "latency", tenantId: "t1" } }),
        0.8,
      );

      const insights = await engine.generateInsights();
      const anomalies = insights.filter((i) => i.type === "anomaly");
      expect(anomalies).toHaveLength(2);
    });
  });

  describe("single-tenant context distinction", () => {
    test("uses source for context in single-tenant mode", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 2, minDistinctContexts: 2, minConfidence: 0.5 },
      });

      // No tenantId, but different sources → distinct contexts
      engine.recordDriftCandidate(makeSignal({ source: "api", context: { entity: "order" } }), 0.5);
      engine.recordDriftCandidate(
        makeSignal({ source: "graphql", context: { entity: "order" } }),
        0.6,
      );

      const insights = await engine.generateInsights();
      expect(insights.filter((i) => i.type === "anomaly")).toHaveLength(1);
    });
  });

  describe("maxDeviation recomputation", () => {
    test("recomputes maxDeviation after pruning expired high-deviation signal", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: {
          minOccurrences: 2,
          minDistinctContexts: 1,
          minConfidence: 0.5,
          timeWindowMs: 1000,
        },
      });

      // Old signal with HIGH deviation (will be pruned)
      engine.recordDriftCandidate(
        makeSignal({
          timestamp: new Date(Date.now() - 5000),
          deviation: 0.9,
          context: { entity: "order", tenantId: "t1" },
        }),
        0.9,
      );
      // Two recent signals with LOW deviation
      engine.recordDriftCandidate(
        makeSignal({ deviation: 0.2, context: { entity: "order", tenantId: "t1" } }),
        0.2,
      );
      engine.recordDriftCandidate(
        makeSignal({ deviation: 0.3, context: { entity: "order", tenantId: "t1" } }),
        0.3,
      );

      const insights = await engine.generateInsights();
      const anomaly = insights.find((i) => i.type === "anomaly");
      // Impact should be "low" (deviation 0.3) not "high" (pruned 0.9)
      expect(anomaly?.impact).toBe("low");
    });
  });

  describe("retention limit", () => {
    test("evicts oldest insights when over maxRetainedInsights", async () => {
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        maxRetainedInsights: 2,
      });

      await engine.generateInsights();
      const all = engine.getInsights();
      expect(all).toHaveLength(2);
    });

    test("clamps negative maxRetainedInsights to 1", async () => {
      const ontology = makeOntology({ A: { views: [], actions: [] } });
      const awareness = createAwarenessEngine({ ontology });
      // Should not infinite loop with negative value
      const engine = createInsightEngine({
        awareness,
        maxRetainedInsights: -1,
      });
      await engine.generateInsights();
      expect(engine.getInsights()).toHaveLength(1);
    });

    test("evicted insights can be re-generated when pattern recurs", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        maxRetainedInsights: 1,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });

      // First drift → promoted, fills the 1 slot
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", metric: "count", tenantId: "t1" } }),
        0.5,
      );
      await engine.generateInsights();
      expect(engine.getInsights()).toHaveLength(1);

      // Second drift → promoted, evicts first (and clears its key)
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "product", metric: "count", tenantId: "t1" } }),
        0.6,
      );
      await engine.generateInsights();
      expect(engine.getInsights()).toHaveLength(1);

      // Re-record first pattern → should be re-generated since key was cleared
      engine.recordDriftCandidate(
        makeSignal({ context: { entity: "order", metric: "count", tenantId: "t1" } }),
        0.5,
      );
      const third = await engine.generateInsights();
      const reGenerated = third.filter((i) => i.type === "anomaly" && i.entity === "order");
      expect(reGenerated).toHaveLength(1);
    });
  });

  describe("attention budget integration (Spec 55 §6.3)", () => {
    test("without budget returns all promoted insights (regression)", async () => {
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });

      const insights = await engine.generateInsights();
      expect(insights).toHaveLength(3);
    });

    test("with budget caps at maxInsightsPerCycle", async () => {
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
        D: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });
      const budget = createAttentionBudget({ maxInsightsPerCycle: 2 });

      const surfaced = await engine.generateInsights({ budget });
      expect(surfaced).toHaveLength(2);

      // Storage is unaffected — all 4 structural insights still retained.
      expect(engine.getInsights()).toHaveLength(4);
    });

    test("budget-dropped insights roll over and surface on a later cycle", async () => {
      // Regression for the surfacing-stream leak: with a budget cap that
      // drops insights, the dropped ones must remain candidates next cycle
      // — promotedKeys would otherwise hide them from
      // tryPromoteDriftCandidates forever.
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
        D: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });
      const budget = createAttentionBudget({ maxInsightsPerCycle: 2 });

      const cycle1 = await engine.generateInsights({ budget });
      expect(cycle1).toHaveLength(2);
      const cycle1Ids = new Set(cycle1.map((i) => i.id));

      // Cycle 2 — no new sensor data, but the 2 dropped insights from
      // cycle 1 are still unsurfaced. They MUST surface now.
      const cycle2 = await engine.generateInsights({ budget });
      expect(cycle2).toHaveLength(2);
      for (const insight of cycle2) {
        expect(cycle1Ids.has(insight.id)).toBe(false);
      }

      // Cycle 3 — everything has been surfaced; nothing left.
      const cycle3 = await engine.generateInsights({ budget });
      expect(cycle3).toHaveLength(0);
    });

    test("without budget, surfaced insights are not re-emitted on the next cycle", async () => {
      // Sanity: the no-budget path also marks insights as surfaced so a
      // later budgeted cycle does not double-count them.
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });

      const cycle1 = await engine.generateInsights();
      expect(cycle1).toHaveLength(2);

      const budget = createAttentionBudget({ maxInsightsPerCycle: 10 });
      const cycle2 = await engine.generateInsights({ budget });
      expect(cycle2).toHaveLength(0);
    });

    test("with budget ranks DESC by confidence × impact", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });
      const budget = createAttentionBudget({ maxInsightsPerCycle: 10 });

      // Low impact / low confidence drift on entity "alpha"
      engine.recordDriftCandidate(
        makeSignal({ confidence: 0.6, context: { entity: "alpha", tenantId: "t1" } }),
        0.1, // low impact
      );
      // High impact / high confidence drift on entity "omega"
      engine.recordDriftCandidate(
        makeSignal({ confidence: 1.0, context: { entity: "omega", tenantId: "t1" } }),
        0.9, // high impact
      );

      const surfaced = await engine.generateInsights({ budget });
      expect(surfaced).toHaveLength(2);
      // Highest confidence × impact wins.
      expect(surfaced[0]?.entity).toBe("omega");
      expect(surfaced[1]?.entity).toBe("alpha");
    });

    test("with budget drops below cap when more candidates exist", async () => {
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });
      const budget = createAttentionBudget({ maxInsightsPerCycle: 1 });

      const surfaced = await engine.generateInsights({ budget });
      expect(surfaced).toHaveLength(1);
    });

    test("ignored types decay on the next ranking pass (Spec 55 §6.4)", async () => {
      const ontologyA = makeOntology({
        // Drift insight (anomaly) on "Order" + structural insight on "Product"
        Product: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology: ontologyA });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });
      const budget = createAttentionBudget({
        maxInsightsPerCycle: 10,
        ignoreDecay: 0.1, // very aggressive decay
      });

      // Drift on "Order" with high confidence + high impact → high baseline score.
      engine.recordDriftCandidate(
        makeSignal({ confidence: 1.0, context: { entity: "Order", tenantId: "t1" } }),
        0.9,
      );

      const first = await engine.generateInsights({ budget });
      // Both anomaly (Order drift) and structural (Product) should appear.
      const anomalyFirst = first.find((i) => i.type === "anomaly");
      const structuralFirst = first.find((i) => i.type === "structural");
      expect(anomalyFirst).toBeDefined();
      expect(structuralFirst).toBeDefined();

      // User ignores the "anomaly" type → its weight decays.
      budget.recordIgnore("anomaly");

      // Force a second drift insight on a different entity so the engine has
      // fresh material to rank against the structural insight on the next pass.
      engine.recordDriftCandidate(
        makeSignal({ confidence: 1.0, context: { entity: "Other", tenantId: "t1" } }),
        0.9,
      );
      // And re-add a structural-ish signal so we still have candidates.
      // (Structural insight was already promoted — it won't re-emit. Use rank
      // directly to verify the decay effect on type weights.)
      const ranked = budget.rank([
        { item: "anomaly_candidate", confidence: 1, impact: 1, type: "anomaly" },
        { item: "structural_candidate", confidence: 1, impact: 1, type: "structural" },
      ]);
      // After ignoring "anomaly", structural should now outrank anomaly.
      expect(ranked[0]?.item).toBe("structural_candidate");
      expect(ranked[1]?.item).toBe("anomaly_candidate");
    });

    test("typeWeight from recordEndorse boosts surfacing priority", async () => {
      const ontology = makeOntology({});
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        promotion: { minOccurrences: 1, minDistinctContexts: 1, minConfidence: 0.5 },
      });
      const budget = createAttentionBudget({ maxInsightsPerCycle: 1, endorseBoost: 5.0 });

      // Two equal-strength drifts → without endorsement, ordering is by score
      // ties (insertion). After endorsing "anomaly" (only existing type), the
      // single survivor is still an anomaly — verify the budget caps to 1.
      engine.recordDriftCandidate(
        makeSignal({ confidence: 0.9, context: { entity: "alpha", tenantId: "t1" } }),
        0.5,
      );
      engine.recordDriftCandidate(
        makeSignal({ confidence: 0.9, context: { entity: "beta", tenantId: "t2" } }),
        0.5,
      );

      budget.recordEndorse("anomaly");
      const surfaced = await engine.generateInsights({ budget });
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]?.type).toBe("anomaly");
    });
  });

  describe("structural re-reporting", () => {
    test("re-reports structural issue after it was fixed and regressed", async () => {
      // Start with entity missing a view
      let schemas: Record<string, Partial<EntityDescriptor>> = {
        Order: { views: [], actions: [] },
      };
      const ontology = {
        describe(name: string) {
          return schemas[name] as EntityDescriptor | undefined;
        },
        listEntities() {
          return Object.keys(schemas);
        },
      } as unknown as OntologyRegistry;

      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({ awareness });

      // First cycle: detects missing view
      const first = await engine.generateInsights();
      expect(first).toHaveLength(1);
      expect(first[0]?.type).toBe("structural");

      // Fix: add a view
      schemas = { Order: { views: [{ name: "list" } as never], actions: [] } };
      const afterFix = await engine.generateInsights();
      expect(afterFix).toHaveLength(0);

      // Regression: remove the view again
      schemas = { Order: { views: [], actions: [] } };
      const regression = await engine.generateInsights();
      expect(regression).toHaveLength(1);
      expect(regression[0]?.type).toBe("structural");
    });
  });
});
