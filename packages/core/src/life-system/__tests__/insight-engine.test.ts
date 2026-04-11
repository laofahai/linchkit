import { describe, expect, test } from "bun:test";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import type { SensorSignal } from "../../types/life-system";
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

  describe("retention limit", () => {
    test("evicts oldest insights when over maxRetainedInsights", async () => {
      // Create 3 entities without views → 3 structural insights
      const ontology = makeOntology({
        A: { views: [], actions: [] },
        B: { views: [], actions: [] },
        C: { views: [], actions: [] },
      });
      const awareness = createAwarenessEngine({ ontology });
      const engine = createInsightEngine({
        awareness,
        maxRetainedInsights: 2, // Only keep 2
      });

      await engine.generateInsights();
      const all = engine.getInsights();
      expect(all).toHaveLength(2); // Oldest evicted
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
