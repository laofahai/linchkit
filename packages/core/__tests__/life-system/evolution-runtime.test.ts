/**
 * Integration test for createEvolutionRuntime — proves the wiring chain:
 *
 *   capability.extensions.sensors → createEvolutionRuntime
 *     → signalBus.registerSensor → runCycle → sensor.detect
 *
 * Without this test the `sensors` field on a CapabilityDefinition is silently
 * dead config: the Codex review caught exactly that defect on the first MVP.
 */

import { describe, expect, test } from "bun:test";
import {
  type CapabilityDefinition,
  createEvolutionRuntime,
  defineSensor,
  type SensorContext,
  type SensorSignal,
} from "../../src";

describe("createEvolutionRuntime", () => {
  test("registers sensors from capability and runCycle collects signals", async () => {
    // Build a trivial sensor that returns a fixed signal whenever ctx.query
    // returns rows. We deliberately consult ctx.query so we can verify the
    // runtime wires the runtime-level `query` default into SensorContext.
    const sensor = defineSensor({
      name: "trivial_sensor",
      source: "event_bus",
      entity: "execution_log",
      detect: async (ctx: SensorContext): Promise<SensorSignal | null> => {
        if (!ctx.query) return null;
        const rows = await ctx.query<{ action_name: string }>("execution_log", {
          action_name: "reject_purchase_request",
          status: "succeeded",
        });
        return {
          sensor: "trivial_sensor",
          source: "event_bus",
          timestamp: ctx.timestamp,
          value: rows.length,
          baseline: 0,
          deviation: 0,
          confidence: 0.9,
          context: { entity: "execution_log", metric: "rejection_count" },
        };
      },
    });

    // Pretend a capability declared this sensor in its extensions.
    const cap: CapabilityDefinition = {
      name: "test-cap",
      label: "Test Cap",
      type: "standard",
      category: "system",
      version: "0.0.0",
      extensions: { sensors: [sensor] },
    };

    // Capture every query call so we can verify the sensor actually invoked it.
    const queryCalls: Array<{ schema: string; filter?: Record<string, unknown> }> = [];
    const queryRows = [
      { action_name: "reject_purchase_request", status: "succeeded" },
      { action_name: "reject_purchase_request", status: "succeeded" },
      { action_name: "reject_purchase_request", status: "succeeded" },
    ];

    const runtime = createEvolutionRuntime({
      sensors: cap.extensions?.sensors ?? [],
      query: async <T>(schema: string, filter?: Record<string, unknown>) => {
        queryCalls.push({ schema, filter });
        return queryRows as T[];
      },
    });

    // Wiring assertion #1: SignalBus knows about the sensor.
    expect(runtime.signalBus.listSensors()).toContain("trivial_sensor");

    // Wiring assertion #2: runCycle propagates ctx (and our default query)
    // into sensors and aggregates the resulting signals.
    const result = await runtime.evolutionCycle.runCycle({ timestamp: new Date() });
    expect(result.signalsCollected).toBeGreaterThanOrEqual(1);

    // Wiring assertion #3: the runtime-level `query` was actually used.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.schema).toBe("execution_log");
    expect(queryCalls[0]?.filter).toEqual({
      action_name: "reject_purchase_request",
      status: "succeeded",
    });
  });

  test("caller-supplied ctx.query overrides the runtime default", async () => {
    let runtimeQueryCalls = 0;
    let callerQueryCalls = 0;

    const sensor = defineSensor({
      name: "override_sensor",
      source: "event_bus",
      detect: async (ctx: SensorContext): Promise<SensorSignal | null> => {
        if (!ctx.query) return null;
        await ctx.query("execution_log");
        return {
          sensor: "override_sensor",
          source: "event_bus",
          timestamp: ctx.timestamp,
          value: 1,
          baseline: 0,
          deviation: 0,
          confidence: 0.5,
          context: {},
        };
      },
    });

    const runtime = createEvolutionRuntime({
      sensors: [sensor],
      query: async () => {
        runtimeQueryCalls++;
        return [];
      },
    });

    await runtime.evolutionCycle.runCycle({
      timestamp: new Date(),
      query: async () => {
        callerQueryCalls++;
        return [];
      },
    });

    expect(callerQueryCalls).toBe(1);
    expect(runtimeQueryCalls).toBe(0);
  });

  test("queryFactory builds a per-tenant scoped query for each cycle (#500)", async () => {
    // The factory is invoked PER runCycle with that cycle's tenantId, so a
    // per-tenant cycle reads only its own data. Single-tenant/dev runs pass no
    // tenantId and the factory receives undefined (unscoped, prior behavior).
    const factoryTenantIds: Array<string | undefined> = [];
    const sensor = defineSensor({
      name: "tenant_sensor",
      source: "event_bus",
      detect: async (ctx: SensorContext): Promise<SensorSignal | null> => {
        await ctx.query?.("execution_log");
        return null;
      },
    });

    const runtime = createEvolutionRuntime({
      sensors: [sensor],
      queryFactory: (tenantId) => {
        factoryTenantIds.push(tenantId);
        return async () => [];
      },
    });

    await runtime.evolutionCycle.runCycle({ timestamp: new Date(), tenantId: "tenant-a" });
    await runtime.evolutionCycle.runCycle({ timestamp: new Date(), tenantId: "tenant-b" });
    await runtime.evolutionCycle.runCycle({ timestamp: new Date() }); // no tenant → undefined

    expect(factoryTenantIds).toEqual(["tenant-a", "tenant-b", undefined]);
  });

  test("caller-supplied ctx.query wins over queryFactory (#500)", async () => {
    let factoryCalls = 0;
    let callerCalls = 0;
    const sensor = defineSensor({
      name: "factory_override_sensor",
      source: "event_bus",
      detect: async (ctx: SensorContext): Promise<SensorSignal | null> => {
        await ctx.query?.("execution_log");
        return null;
      },
    });

    const runtime = createEvolutionRuntime({
      sensors: [sensor],
      queryFactory: () => {
        factoryCalls++;
        return async () => [];
      },
    });

    await runtime.evolutionCycle.runCycle({
      timestamp: new Date(),
      tenantId: "tenant-a",
      query: async () => {
        callerCalls++;
        return [];
      },
    });

    expect(callerCalls).toBe(1);
    // The factory is never consulted when the caller brought its own query.
    expect(factoryCalls).toBe(0);
  });

  test("works with zero sensors", async () => {
    const runtime = createEvolutionRuntime({ sensors: [] });
    expect(runtime.signalBus.listSensors()).toEqual([]);
    const result = await runtime.evolutionCycle.runCycle();
    expect(result.signalsCollected).toBe(0);
  });

  test("forwards proposalPreAnalysisPipeline through to inner cycle (Spec 55 §7.3)", async () => {
    // Without this forwarding the pipeline option is dead config — production
    // wiring builds cycles via createEvolutionRuntime, never the lower-level
    // factory. Codex P1 caught exactly this gap on the #280 MVP.
    const { createDefaultInsightTranslatorRegistry } = await import(
      "../../src/life-system/insight-to-proposal"
    );
    const { createPreAnalysisPipeline } = await import(
      "../../src/life-system/proposal-preanalysis"
    );

    let pipelineCalls = 0;
    const pipeline = createPreAnalysisPipeline({
      analyzers: [
        {
          stage: "dedup",
          name: "spy_dedup",
          analyze: async () => {
            pipelineCalls++;
            return { similar: [], exactMatch: null, payloadHash: "spy" };
          },
        },
      ],
    });

    const ontology = {
      describe: (name: string) =>
        name === "Order" ? ({ views: [], actions: [], fields: {} } as never) : undefined,
      listEntities: () => ["Order"],
      searchEntities: () => [],
      actionsFor: () => [],
      rulesFor: () => [],
      stateFor: () => undefined,
      viewsFor: () => [],
      flowsFor: () => [],
      handlersFor: () => [],
      relatedEntities: () => [],
      entitiesImplementing: () => [],
      toJSON: () => ({}),
      toMarkdown: () => "",
    };

    const runtime = createEvolutionRuntime({
      sensors: [],
      ontology,
      translatorRegistry: createDefaultInsightTranslatorRegistry(),
      proposalPreAnalysisPipeline: pipeline,
    });

    const result = await runtime.evolutionCycle.runCycle();

    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    expect(result.proposalAnalyses).toHaveLength(result.proposals.length);
    expect(pipelineCalls).toBe(result.proposals.length);
    expect(result.proposalAnalyses[0]?.stages.dedup?.status).toBe("ok");
  });

  test("throws on duplicate sensor names", () => {
    // Two sensors with the same name silently overwrite each other on SignalBus
    // (Map keyed by name). Duplicates indicate a capability misconfiguration
    // and should fail fast.
    const a = defineSensor({
      name: "dup_sensor",
      source: "event_bus",
      detect: async () => null,
    });
    const b = defineSensor({
      name: "dup_sensor",
      source: "api",
      detect: async () => null,
    });

    expect(() => createEvolutionRuntime({ sensors: [a, b] })).toThrow(/Duplicate sensor name/);
  });
});
