import { describe, expect, it } from "bun:test";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";
import { MemoryEngine } from "../../life-system/memory-engine";
import type { SensorSignal } from "../../types/life-system";

// ── Helpers ───────────────────────────────────────────────

function makeSensorSignal(overrides: Partial<SensorSignal> = {}): SensorSignal {
  return {
    sensor: "test_sensor",
    source: "event_bus",
    timestamp: new Date(),
    value: 10,
    baseline: 10,
    deviation: 0,
    confidence: 1,
    context: { entity: "order", metric: "count", ...overrides.context },
    ...overrides,
  };
}

// ── InMemoryMemoryStore ───────────────────────────────────

describe("InMemoryMemoryStore", () => {
  it("records a signal and retrieves it via getSignals", async () => {
    const store = new InMemoryMemoryStore();
    const signal = {
      type: "sensor_a",
      source: "api" as const,
      timestamp: new Date(),
      payload: { value: 5, entity: "order", metric: "count" },
    };

    await store.recordSignal(signal);
    const signals = await store.getSignals();
    expect(signals).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(signals[0]!.type).toBe("sensor_a");
  });

  it("getSignals filters by entity via payload.entity", async () => {
    const store = new InMemoryMemoryStore();
    await store.recordSignal({
      type: "s1",
      source: "api",
      timestamp: new Date(),
      payload: { value: 1, entity: "order", metric: "count" },
    });
    await store.recordSignal({
      type: "s2",
      source: "api",
      timestamp: new Date(),
      payload: { value: 2, entity: "invoice", metric: "count" },
    });

    const orders = await store.getSignals({ entity: "order" });
    expect(orders).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(orders[0]!.type).toBe("s1");
  });

  it("getSignals filters by since date", async () => {
    const store = new InMemoryMemoryStore();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recent = new Date();

    await store.recordSignal({
      type: "old",
      source: "api",
      timestamp: old,
      payload: { value: 1, entity: "order", metric: "count" },
    });
    await store.recordSignal({
      type: "new",
      source: "api",
      timestamp: recent,
      payload: { value: 2, entity: "order", metric: "count" },
    });

    const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const result = await store.getSignals({ since });
    expect(result).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(result[0]!.type).toBe("new");
  });

  it("getSignals limits results", async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.recordSignal({
        type: `s${i}`,
        source: "api",
        timestamp: new Date(),
        payload: { value: i, entity: "order", metric: "count" },
      });
    }
    const result = await store.getSignals({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("stores and retrieves baselines by schema+metric key", async () => {
    const store = new InMemoryMemoryStore();
    expect(await store.getBaseline("order", "count")).toBeNull();

    await store.updateBaseline({
      entity: "order",
      metric: "count",
      value: 42,
      calculatedAt: new Date(),
    });

    const baseline = await store.getBaseline("order", "count");
    expect(baseline).not.toBeNull();
    expect(baseline?.value).toBe(42);
  });

  it("upserts baseline — second update overwrites", async () => {
    const store = new InMemoryMemoryStore();
    await store.updateBaseline({ entity: "a", metric: "m", value: 1, calculatedAt: new Date() });
    await store.updateBaseline({ entity: "a", metric: "m", value: 99, calculatedAt: new Date() });

    const b = await store.getBaseline("a", "m");
    expect(b?.value).toBe(99);
  });

  it("distinguishes baselines by schema", async () => {
    const store = new InMemoryMemoryStore();
    await store.updateBaseline({
      entity: "order",
      metric: "count",
      value: 10,
      calculatedAt: new Date(),
    });
    await store.updateBaseline({
      entity: "invoice",
      metric: "count",
      value: 20,
      calculatedAt: new Date(),
    });

    expect((await store.getBaseline("order", "count"))?.value).toBe(10);
    expect((await store.getBaseline("invoice", "count"))?.value).toBe(20);
  });
});

// ── MemoryEngine ──────────────────────────────────────────

describe("MemoryEngine", () => {
  describe("ingest", () => {
    it("records a signal in the store", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await engine.ingest(makeSensorSignal({ value: 5 }));
      expect(store.signalCount).toBe(1);
    });

    it("updates the baseline after ingestion", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await engine.ingest(makeSensorSignal({ value: 20 }));
      const baseline = await store.getBaseline("order", "count");
      expect(baseline).not.toBeNull();
      expect(baseline?.value).toBe(20);
    });

    it("ingest multiple signals — baseline is average", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await engine.ingest(makeSensorSignal({ value: 10 }));
      await engine.ingest(makeSensorSignal({ value: 20 }));
      await engine.ingest(makeSensorSignal({ value: 30 }));

      const baseline = await store.getBaseline("order", "count");
      expect(baseline?.value).toBeCloseTo(20, 5);
    });
  });

  describe("computeBaseline", () => {
    it("returns 0 for empty window", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      const baseline = await engine.computeBaseline("order", "count");
      expect(baseline.value).toBe(0);
    });

    it("computes sliding window average correctly", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store, windowSize: 30 });

      await engine.ingest(makeSensorSignal({ value: 10 }));
      await engine.ingest(makeSensorSignal({ value: 20 }));

      const baseline = await engine.computeBaseline("order", "count");
      expect(baseline.value).toBeCloseTo(15, 5);
    });

    it("ignores signals outside window", async () => {
      const store = new InMemoryMemoryStore();
      // Use windowSize=1 day
      const engine = new MemoryEngine({ store, windowSize: 1 });

      // Record an old signal directly (40 days ago) — outside window
      await store.recordSignal({
        type: "test_sensor",
        source: "event_bus",
        timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        payload: { value: 999, entity: "order", metric: "count" },
      });

      // Recent signal
      await engine.ingest(makeSensorSignal({ value: 5 }));

      const baseline = await engine.computeBaseline("order", "count");
      expect(baseline.value).toBe(5);
    });

    it("persists the computed baseline", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await engine.ingest(makeSensorSignal({ value: 50 }));
      const computed = await engine.computeBaseline("order", "count");

      const stored = await engine.getBaseline("order", "count");
      expect(stored?.value).toBeCloseTo(computed.value, 5);
    });
  });

  describe("detectDrift", () => {
    it("returns no drift when no baseline exists (first observation)", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      const result = await engine.detectDrift(makeSensorSignal({ value: 100 }));
      expect(result.drifted).toBe(false);
      expect(result.deviation).toBe(0);
    });

    it("returns no drift when value is within threshold", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store, driftThreshold: 0.3 });

      await store.updateBaseline({
        entity: "order",
        metric: "count",
        value: 100,
        calculatedAt: new Date(),
      });
      // 10% deviation — below 30% threshold
      const result = await engine.detectDrift(makeSensorSignal({ value: 110 }));
      expect(result.drifted).toBe(false);
      expect(result.deviation).toBeCloseTo(0.1, 5);
    });

    it("returns drift when value exceeds threshold", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store, driftThreshold: 0.3 });

      await store.updateBaseline({
        entity: "order",
        metric: "count",
        value: 100,
        calculatedAt: new Date(),
      });
      // 50% deviation — above 30% threshold
      const result = await engine.detectDrift(makeSensorSignal({ value: 150 }));
      expect(result.drifted).toBe(true);
      expect(result.deviation).toBeCloseTo(0.5, 5);
    });

    it("handles zero baseline without division error", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await store.updateBaseline({
        entity: "order",
        metric: "count",
        value: 0,
        calculatedAt: new Date(),
      });
      const result = await engine.detectDrift(makeSensorSignal({ value: 5 }));
      // denominator falls back to 1, so deviation = 5/1 = 5
      expect(result.deviation).toBe(5);
      expect(result.drifted).toBe(true);
    });

    it("negative drift also counts as drift", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store, driftThreshold: 0.3 });

      await store.updateBaseline({
        entity: "order",
        metric: "count",
        value: 100,
        calculatedAt: new Date(),
      });
      // value dropped to 50 — 50% drop
      const result = await engine.detectDrift(makeSensorSignal({ value: 50 }));
      expect(result.drifted).toBe(true);
      expect(result.deviation).toBeCloseTo(0.5, 5);
    });
  });

  describe("getBaseline", () => {
    it("returns null when no baseline exists", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });
      expect(await engine.getBaseline("nonexistent", "metric")).toBeNull();
    });

    it("delegates to store", async () => {
      const store = new InMemoryMemoryStore();
      const engine = new MemoryEngine({ store });

      await store.updateBaseline({
        entity: "order",
        metric: "count",
        value: 77,
        calculatedAt: new Date(),
      });
      const b = await engine.getBaseline("order", "count");
      expect(b?.value).toBe(77);
    });
  });
});
