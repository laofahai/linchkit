import { describe, expect, test } from "bun:test";
import type { EntityDescriptor, OntologyRegistry } from "../../ontology/ontology-registry";
import type { SensorSignal } from "../../types/life-system";
import { createAwarenessEngine } from "../awareness-engine";
import { defineSensor } from "../define-sensor";
import { createEvolutionCycle } from "../evolution-cycle";
import { InMemoryMemoryStore } from "../in-memory-memory-store";
import { MemoryEngine } from "../memory-engine";
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
});
