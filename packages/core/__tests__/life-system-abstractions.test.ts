/**
 * Tests for the Spec 56 Phase 2 Step 2a life-system abstractions.
 *
 * Covers:
 *   - Compile-time shape assertions for the public interfaces
 *   - A trivial in-memory MemoryStore round-trip (read/write/delete/list)
 *   - A trivial Sensor registered into the extensions.sensors slot,
 *     emitting a Signal that round-trips through subscribe()
 *   - A toy Baseline whose score() returns 0 for in-distribution data
 *     and >0 for outliers (sanity check, not statistical correctness)
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type Baseline,
  clearSensors,
  findSensor,
  getSensors,
  type MemoryStore,
  type MemoryStoreWriteOptions,
  registerSensor,
  type Sensor,
  type Signal,
  type Unsubscribe,
  unregisterSensor,
} from "../src";

// ── Compile-time shape assertions ──────────────────────────────────────────
//
// These are erased at runtime; their purpose is to fail `bun run typecheck`
// if the public shapes ever drift from the spec. We construct a value of
// each interface and assign it to a variable typed as that interface.

// Signal must accept the documented fields and reject extras only via the
// usual TS structural rules (we don't lock that down here — `metadata` is
// open-ended).
const _signalShape: Signal = {
  source: "event_bus",
  kind: "test.kind",
  data: { anything: true },
  timestamp: Date.now(),
  metadata: { traceId: "abc" },
};
void _signalShape;

// Sensor must expose id + start + stop + subscribe with the documented
// signatures. We don't run this; we just typecheck it.
const _sensorShape: Sensor = {
  id: "test.shape",
  start() {
    /* no-op */
  },
  stop() {
    /* no-op */
  },
  subscribe(_handler: (signal: Signal) => void): Unsubscribe {
    return () => {};
  },
};
void _sensorShape;

// Baseline must expose id + update + score + snapshot.
const _baselineShape: Baseline = {
  id: "test.metric",
  update(_observation: unknown): void {
    /* no-op */
  },
  score(_observation: unknown): number {
    return 0;
  },
  snapshot(): unknown {
    return null;
  },
};
void _baselineShape;

// MemoryStore must expose read/write/delete/list with the documented
// async signatures.
const _memoryStoreShape: MemoryStore = {
  async read(_key: string): Promise<unknown | null> {
    return null;
  },
  async write(_key: string, _value: unknown, _options?: MemoryStoreWriteOptions): Promise<void> {
    /* no-op */
  },
  async delete(_key: string): Promise<void> {
    /* no-op */
  },
  async list(_prefix?: string): Promise<string[]> {
    return [];
  },
};
void _memoryStoreShape;

// ── In-memory MemoryStore implementation ───────────────────────────────────

interface Entry {
  value: unknown;
  /** Absolute expiry timestamp (ms since epoch), or undefined for no TTL. */
  expiresAt?: number;
}

/**
 * Tiny MemoryStore for tests — backs the `read/write/delete/list` round-trip
 * suite below. Production capabilities (e.g. cap-memory-drizzle) would ship
 * a persistent equivalent.
 */
function createInMemoryStore(): MemoryStore {
  const data = new Map<string, Entry>();

  function isExpired(entry: Entry, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  return {
    async read(key) {
      const entry = data.get(key);
      if (!entry) return null;
      if (isExpired(entry, Date.now())) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    async write(key, value, options) {
      const entry: Entry = { value };
      if (options?.ttlMs !== undefined) {
        entry.expiresAt = Date.now() + options.ttlMs;
      }
      data.set(key, entry);
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      const now = Date.now();
      const result: string[] = [];
      for (const [key, entry] of data.entries()) {
        if (isExpired(entry, now)) {
          data.delete(key);
          continue;
        }
        if (prefix === undefined || key.startsWith(prefix)) {
          result.push(key);
        }
      }
      return result;
    },
  };
}

// ── Toy Sensor implementation ──────────────────────────────────────────────

/**
 * Manually-driven Sensor — `start`/`stop` flip an `active` flag, and
 * `emit()` fans the signal out to subscribers iff the sensor is active.
 * This keeps the test deterministic (no timers).
 */
function createToySensor(id: string): Sensor & { emit(signal: Signal): void; active: boolean } {
  const handlers = new Set<(signal: Signal) => void>();
  let active = false;

  const sensor: Sensor & { emit(signal: Signal): void; active: boolean } = {
    id,
    get active() {
      return active;
    },
    set active(v: boolean) {
      active = v;
    },
    start() {
      active = true;
    },
    stop() {
      active = false;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(signal) {
      if (!active) return;
      for (const handler of handlers) handler(signal);
    },
  };

  return sensor;
}

// ── Toy Baseline implementation ────────────────────────────────────────────

/**
 * One-dimensional baseline: tracks min/max of observed numbers, scores
 * incoming numbers as 0 when inside the range, otherwise normalised
 * distance from the range (clamped to 1).
 *
 * Not statistically meaningful — the test only checks the contract:
 * 0 for in-distribution, >0 for outliers.
 */
function createRangeBaseline(id: string): Baseline {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  return {
    id,
    update(observation) {
      if (typeof observation !== "number") return;
      if (observation < min) min = observation;
      if (observation > max) max = observation;
    },
    score(observation) {
      if (typeof observation !== "number") return 0;
      if (max < min) return 0; // no observations yet
      if (observation >= min && observation <= max) return 0;
      const range = max - min || 1;
      const distance = observation < min ? min - observation : observation - max;
      return Math.min(1, distance / range);
    },
    snapshot() {
      return { min, max };
    },
  };
}

// ── Test cases ─────────────────────────────────────────────────────────────

afterEach(() => {
  // Each registry test starts from a clean slate — earlier failures must
  // not leak sensors into later runs.
  clearSensors();
});

describe("MemoryStore (in-memory implementation)", () => {
  test("round-trips read / write / delete / list", async () => {
    const store = createInMemoryStore();

    // write + read round-trip
    await store.write("alpha", { value: 1 });
    expect(await store.read("alpha")).toEqual({ value: 1 });

    // missing key returns null
    expect(await store.read("missing")).toBeNull();

    // list returns all written keys
    await store.write("beta", "hello");
    const all = await store.list();
    expect(all.sort()).toEqual(["alpha", "beta"]);

    // list with prefix filters
    await store.write("alpha:nested", 42);
    const filtered = await store.list("alpha");
    expect(filtered.sort()).toEqual(["alpha", "alpha:nested"]);

    // delete removes the key
    await store.delete("alpha");
    expect(await store.read("alpha")).toBeNull();
    expect((await store.list()).sort()).toEqual(["alpha:nested", "beta"]);

    // delete on missing key is a no-op
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });

  test("respects ttlMs on write", async () => {
    const store = createInMemoryStore();
    await store.write("ephemeral", "soon-gone", { ttlMs: 1 });

    // Wait past the TTL — Bun's setTimeout resolution is fine for 1ms.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await store.read("ephemeral")).toBeNull();
    expect(await store.list()).not.toContain("ephemeral");
  });
});

describe("Sensor + extensions.sensors slot", () => {
  test("registerSensor exposes the sensor via getSensors / findSensor", () => {
    const sensor = createToySensor("toy.alpha");
    registerSensor(sensor);

    expect(getSensors()).toContain(sensor);
    expect(findSensor("toy.alpha")).toBe(sensor);
    expect(findSensor("missing")).toBeUndefined();
  });

  test("registerSensor rejects duplicate IDs", () => {
    registerSensor(createToySensor("toy.dup"));
    expect(() => registerSensor(createToySensor("toy.dup"))).toThrow(/already registered/);
  });

  test("unregisterSensor removes the entry and reports success", () => {
    const sensor = createToySensor("toy.unreg");
    registerSensor(sensor);

    expect(unregisterSensor("toy.unreg")).toBe(true);
    expect(findSensor("toy.unreg")).toBeUndefined();

    // second call is a no-op
    expect(unregisterSensor("toy.unreg")).toBe(false);
  });

  test("subscribe receives signals emitted while the sensor is started", async () => {
    const sensor = createToySensor("toy.emit");
    registerSensor(sensor);

    const received: Signal[] = [];
    const unsub: Unsubscribe = sensor.subscribe((s) => received.push(s));

    // Before start, emit is dropped.
    sensor.emit({ source: "test", kind: "noop", data: null, timestamp: 0 });
    expect(received).toEqual([]);

    // After start, signals flow.
    await sensor.start();
    const signal: Signal = {
      source: "test",
      kind: "ping",
      data: { hello: "world" },
      timestamp: 1234,
      metadata: { trace: "t1" },
    };
    sensor.emit(signal);

    expect(received).toEqual([signal]);

    // unsubscribe stops further deliveries
    unsub();
    sensor.emit({ ...signal, kind: "ignored" });
    expect(received).toEqual([signal]);

    // stop ignores subsequent emits even if a new subscriber attaches
    await sensor.stop();
    const after: Signal[] = [];
    sensor.subscribe((s) => after.push(s));
    sensor.emit({ ...signal, kind: "post-stop" });
    expect(after).toEqual([]);
  });
});

describe("Baseline (toy implementation)", () => {
  test("scores 0 for in-distribution observations and >0 for outliers", () => {
    const baseline = createRangeBaseline("range.test");

    // Train on a small in-distribution sample.
    for (const sample of [10, 11, 12, 13, 14, 15]) {
      baseline.update(sample);
    }

    // In-distribution → 0.
    expect(baseline.score(10)).toBe(0);
    expect(baseline.score(13)).toBe(0);
    expect(baseline.score(15)).toBe(0);

    // Outliers → strictly greater than 0, clamped to [0, 1].
    const lowOutlier = baseline.score(0);
    const highOutlier = baseline.score(100);
    expect(lowOutlier).toBeGreaterThan(0);
    expect(lowOutlier).toBeLessThanOrEqual(1);
    expect(highOutlier).toBeGreaterThan(0);
    expect(highOutlier).toBeLessThanOrEqual(1);

    // snapshot exposes the learned range as `unknown` (we cast for the assert).
    const snap = baseline.snapshot() as { min: number; max: number };
    expect(snap.min).toBe(10);
    expect(snap.max).toBe(15);
  });

  test("score() returns 0 before any observations", () => {
    const baseline = createRangeBaseline("range.empty");
    expect(baseline.score(42)).toBe(0);
  });
});
