import { describe, expect, it } from "bun:test";
import { defineSensor } from "../../life-system/define-sensor";
import { createSignalBus } from "../../life-system/signal-bus";
import type { SensorContext, SensorSignal } from "../../types/life-system";

const makeCtx = (): SensorContext => ({ timestamp: new Date() });

const makeSignal = (overrides: Partial<SensorSignal> = {}): SensorSignal => ({
  sensor: "test_sensor",
  source: "event_bus",
  timestamp: new Date(),
  value: 1,
  baseline: 1,
  deviation: 0,
  confidence: 1,
  context: {},
  ...overrides,
});

describe("createSignalBus", () => {
  it("returns empty sensor list initially", () => {
    const bus = createSignalBus();
    expect(bus.listSensors()).toEqual([]);
  });

  it("registers and lists sensors", () => {
    const bus = createSignalBus();
    const sensor = defineSensor({
      name: "sensor_a",
      source: "api",
      detect: async () => null,
    });
    bus.registerSensor(sensor);
    expect(bus.listSensors()).toContain("sensor_a");
  });

  it("unregisters sensors", () => {
    const bus = createSignalBus();
    const sensor = defineSensor({
      name: "sensor_b",
      source: "api",
      detect: async () => null,
    });
    bus.registerSensor(sensor);
    bus.unregisterSensor("sensor_b");
    expect(bus.listSensors()).not.toContain("sensor_b");
  });

  it("collectSignals returns signals from detect()", async () => {
    const bus = createSignalBus();
    const signal = makeSignal({ sensor: "my_sensor" });
    const sensor = defineSensor({
      name: "my_sensor",
      source: "event_bus",
      detect: async () => signal,
    });
    bus.registerSensor(sensor);
    const results = await bus.collectSignals(makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(signal);
  });

  it("collectSignals skips null results", async () => {
    const bus = createSignalBus();
    const sensor = defineSensor({
      name: "null_sensor",
      source: "api",
      detect: async () => null,
    });
    bus.registerSensor(sensor);
    const results = await bus.collectSignals(makeCtx());
    expect(results).toHaveLength(0);
  });

  it("collectSignals publishes signals to subscribers", async () => {
    const bus = createSignalBus();
    const signal = makeSignal({ sensor: "pub_sensor" });
    const sensor = defineSensor({
      name: "pub_sensor",
      source: "graphql",
      detect: async () => signal,
    });
    bus.registerSensor(sensor);

    const received: SensorSignal[] = [];
    bus.subscribe((s) => {
      received.push(s);
    });

    await bus.collectSignals(makeCtx());
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(signal);
  });

  it("subscribe returns an unsubscribe function", async () => {
    const bus = createSignalBus();
    const signal = makeSignal({ sensor: "unsub_sensor" });
    const sensor = defineSensor({
      name: "unsub_sensor",
      source: "ui",
      detect: async () => signal,
    });
    bus.registerSensor(sensor);

    const received: SensorSignal[] = [];
    const unsub = bus.subscribe((s) => {
      received.push(s);
    });
    unsub();

    await bus.collectSignals(makeCtx());
    expect(received).toHaveLength(0);
  });

  it("emit publishes a signal directly without running sensors", async () => {
    const bus = createSignalBus();
    const signal = makeSignal({ sensor: "direct" });

    const received: SensorSignal[] = [];
    bus.subscribe((s) => {
      received.push(s);
    });

    await bus.emit(signal);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(signal);
  });

  it("handles sensor errors via onError without throwing", async () => {
    const errors: Array<{ sensor: string; err: unknown }> = [];
    const bus = createSignalBus({
      onError: (sensor, err) => {
        errors.push({ sensor, err });
      },
    });

    const sensor = defineSensor({
      name: "broken_sensor",
      source: "server",
      detect: async () => {
        throw new Error("boom");
      },
    });
    bus.registerSensor(sensor);

    const results = await bus.collectSignals(makeCtx());
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.sensor).toBe("broken_sensor");
  });

  it("collectSignals aggregates signals from multiple sensors", async () => {
    const bus = createSignalBus();
    for (let i = 0; i < 3; i++) {
      const s = defineSensor({
        name: `sensor_${i}`,
        source: "event_bus",
        detect: async () => makeSignal({ sensor: `sensor_${i}` }),
      });
      bus.registerSensor(s);
    }

    const results = await bus.collectSignals(makeCtx());
    expect(results).toHaveLength(3);
  });
});

describe("defineSensor", () => {
  it("creates a sensor with the specified fields", () => {
    const detect = async (_ctx: SensorContext) => null;
    const sensor = defineSensor({
      name: "my_sensor",
      source: "mcp",
      schema: "purchase_request",
      detect,
    });

    expect(sensor.name).toBe("my_sensor");
    expect(sensor.source).toBe("mcp");
    expect(sensor.schema).toBe("purchase_request");
    expect(sensor.detect).toBe(detect);
  });

  it("schema is optional", () => {
    const sensor = defineSensor({
      name: "global_sensor",
      source: "api",
      detect: async () => null,
    });
    expect(sensor.schema).toBeUndefined();
  });
});
