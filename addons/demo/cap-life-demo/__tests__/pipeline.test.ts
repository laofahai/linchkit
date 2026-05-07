/**
 * End-to-end tests for the Spec 55 life-system demo skeleton.
 *
 * Each test drives the pipeline through `controller.tick()` so we never
 * have to wait on real timers. The polling timer is exercised separately
 * in the cleanup test, where we verify `stop()` actually clears it and
 * unsubscribes from the sensor.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LifecycleSignal } from "@linchkit/core";
import { findSensor, getSensors, registerSensor, unregisterSensor } from "@linchkit/core";
import { CountingBaseline } from "../src/counting-baseline";
import { InMemoryLifecycleStore } from "../src/in-memory-store";
import { run } from "../src/pipeline";
import { PollSensor } from "../src/poll-sensor";

const SENSOR_ID = "life-demo.tick";

function makePipeline(values: number[]) {
  let cursor = 0;
  let clock = 1_000;
  const sensor = new PollSensor({
    id: SENSOR_ID,
    intervalMs: 250,
    produce: () => ({ value: values[Math.min(cursor++, values.length - 1)] ?? 0 }),
    now: () => {
      clock += 1;
      return clock;
    },
  });
  const store = new InMemoryLifecycleStore();
  const baseline = new CountingBaseline({ id: "life-demo.tick.value", warmup: 2 });
  const anomalies: Array<{ signal: LifecycleSignal; score: number }> = [];
  const controller = run({
    sensor,
    store,
    baseline,
    anomalyThreshold: 0.5,
    onAnomaly: (signal, score) => anomalies.push({ signal, score }),
  });
  // Register into the global sensor-registry so afterEach cleanup is effective
  // even if a test throws before reaching `controller.stop()`. The
  // sensor-registry helper test has its own dedicated registration and is
  // tolerant of double-register via try/catch.
  try {
    registerSensor(sensor);
  } catch {
    // Already registered (e.g. by a test that re-registers explicitly) — ignore.
  }
  return { sensor, store, baseline, controller, anomalies };
}

afterEach(async () => {
  // The demo only registers a single sensor under SENSOR_ID per test (now
  // happens inside makePipeline). unregisterSensor handles its own
  // stop()+remove cleanup, so a failing test still releases the polling timer.
  await unregisterSensor(SENSOR_ID);
});

describe("life-system demo pipeline", () => {
  test("normal flow: every signal lands in the memory store", async () => {
    const { store, controller } = makePipeline([1, 2, 3, 4]);
    try {
      await controller.tick();
      await controller.tick();
      await controller.tick();
      const page = await store.list(`signals/${SENSOR_ID}/`);
      expect(page.keys.length).toBe(3);
      expect(store.size()).toBe(3);
    } finally {
      controller.stop();
    }
  });

  test("spike detection: anomaly callback fires exactly once for the outlier", async () => {
    // Three small values establish a low baseline (mean ~ 1), then a big
    // spike (1000) crosses the spikeMultiplier (default 5) threshold.
    const { controller, anomalies } = makePipeline([1, 1, 1, 1000, 1]);
    try {
      await controller.tick(); // value=1, warmup
      await controller.tick(); // value=1
      await controller.tick(); // value=1, baseline now warm
      await controller.tick(); // value=1000 — should trip
      await controller.tick(); // value=1 — back to normal

      expect(anomalies.length).toBe(1);
      expect((anomalies[0]?.signal.data as { value: number }).value).toBe(1000);
      expect(anomalies[0]?.score).toBeGreaterThan(0.5);
    } finally {
      controller.stop();
    }
  });

  test("baseline observes every value, including the spike", async () => {
    const { controller, baseline } = makePipeline([2, 4, 6, 100]);
    try {
      await controller.tick();
      await controller.tick();
      await controller.tick();
      await controller.tick();
      const snap = baseline.snapshot() as { count: number; max: number };
      expect(snap.count).toBe(4);
      expect(snap.max).toBe(100);
    } finally {
      controller.stop();
    }
  });

  test("cleanup: stop() unsubscribes and halts the polling timer", async () => {
    const { sensor, controller } = makePipeline([1, 2, 3]);
    expect(sensor.isRunning()).toBe(true);
    expect(sensor.subscriberCount()).toBe(1);

    controller.stop();

    expect(sensor.isRunning()).toBe(false);
    expect(sensor.subscriberCount()).toBe(0);
    expect(controller.isRunning()).toBe(false);

    // Idempotent — a second stop() must not throw.
    controller.stop();
  });

  test("sensor-registry helpers: register, find, getSensors, unregister", async () => {
    const sensor = new PollSensor({
      id: "life-demo.registry-roundtrip",
      intervalMs: 250,
      produce: () => ({ value: 0 }),
    });

    expect(getSensors()).toHaveLength(0);
    registerSensor(sensor);
    expect(getSensors()).toHaveLength(1);
    expect(findSensor(sensor.id)).toBe(sensor);

    const removed = await unregisterSensor(sensor.id);
    expect(removed).toBe(true);
    expect(getSensors()).toHaveLength(0);
    expect(findSensor(sensor.id)).toBeUndefined();
  });

  test("registry rejects duplicate sensor IDs", async () => {
    const a = new PollSensor({
      id: "life-demo.duplicate",
      intervalMs: 250,
      produce: () => ({ value: 0 }),
    });
    const b = new PollSensor({
      id: "life-demo.duplicate",
      intervalMs: 250,
      produce: () => ({ value: 0 }),
    });
    try {
      registerSensor(a);
      expect(() => registerSensor(b)).toThrow(/already registered/);
    } finally {
      // afterEach only cleans SENSOR_ID; this test uses a different id and
      // must remove it itself or it leaks into later tests in this file.
      await unregisterSensor("life-demo.duplicate");
    }
  });
});
