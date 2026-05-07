/**
 * Tests for the Spec 56 Phase 2 Step 2a life-system abstractions
 * (lifecycle-style: LifecycleSensor / LifecycleSignal / LifecycleBaseline /
 * LifecycleMemoryStore).
 *
 * Covers:
 *   - Compile-time shape assertions for the public interfaces
 *   - A trivial in-memory LifecycleMemoryStore round-trip
 *     (read/write/delete/list)
 *   - A trivial LifecycleSensor registered into the lifecycle-sensor
 *     registry, emitting a LifecycleSignal that round-trips through
 *     subscribe()
 *   - A toy LifecycleBaseline whose score() returns 0 for in-distribution
 *     data and >0 for outliers (sanity check, not statistical correctness)
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  findSensor,
  getSensors,
  type LifecycleBaseline,
  type LifecycleMemoryStore,
  type LifecycleSensor,
  type LifecycleSignal,
  type MemoryStoreListOptions,
  type MemoryStoreListPage,
  type MemoryStoreWriteOptions,
  registerSensor,
  type Unsubscribe,
  unregisterSensor,
} from "../src";
// `clearSensors` is intentionally NOT part of the root @linchkit/core export
// (test-only helper). Import it directly from the sensor-registry module.
import { clearSensors } from "../src/life-system/sensor-registry";

// ── Compile-time shape assertions ──────────────────────────────────────────
//
// These are erased at runtime; their purpose is to fail `bun run typecheck`
// if the public shapes ever drift from the spec. We construct a value of
// each interface and assign it to a variable typed as that interface.

// LifecycleSignal must accept the documented fields and reject extras only
// via the usual TS structural rules (we don't lock that down here —
// `metadata` is open-ended).
const _signalShape: LifecycleSignal = {
  source: "event_bus",
  kind: "test.kind",
  data: { anything: true },
  timestamp: Date.now(),
  metadata: { traceId: "abc" },
};
void _signalShape;

// LifecycleSensor must expose id + start + stop + subscribe with the
// documented signatures. We don't run this; we just typecheck it.
const _sensorShape: LifecycleSensor = {
  id: "test.shape",
  start() {
    /* no-op */
  },
  stop() {
    /* no-op */
  },
  subscribe(_handler: (signal: LifecycleSignal) => void): Unsubscribe {
    return () => {};
  },
};
void _sensorShape;

// LifecycleBaseline must expose id + update + score + snapshot.
const _baselineShape: LifecycleBaseline = {
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

// LifecycleMemoryStore must expose read/write/delete/list with the
// documented async signatures (including the paginated list contract).
const _memoryStoreShape: LifecycleMemoryStore = {
  async read(_key: string): Promise<unknown | null> {
    return null;
  },
  async write(_key: string, _value: unknown, _options?: MemoryStoreWriteOptions): Promise<void> {
    /* no-op */
  },
  async delete(_key: string): Promise<void> {
    /* no-op */
  },
  async list(_prefix?: string, _options?: MemoryStoreListOptions): Promise<MemoryStoreListPage> {
    return { keys: [] };
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
 * Tiny LifecycleMemoryStore for tests — backs the `read/write/delete/list`
 * round-trip suite below. Production capabilities (e.g. cap-memory-drizzle)
 * would ship a persistent equivalent.
 */
function createInMemoryStore(): LifecycleMemoryStore {
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
    async list(prefix, options) {
      const now = Date.now();
      // Collect every non-expired matching key first, then slice into a page.
      // Sorted output gives a stable, deterministic cursor (the cursor is the
      // last key returned in the previous page — keys after it form the next
      // page).
      const matching: string[] = [];
      for (const [key, entry] of data.entries()) {
        if (isExpired(entry, now)) {
          data.delete(key);
          continue;
        }
        if (prefix === undefined || key.startsWith(prefix)) {
          matching.push(key);
        }
      }
      matching.sort();

      const cursor = options?.cursor;
      const limit = options?.limit;

      const startIndex = cursor === undefined ? 0 : matching.findIndex((k) => k > cursor);
      const start = startIndex < 0 ? matching.length : startIndex;
      const end = limit === undefined ? matching.length : Math.min(matching.length, start + limit);
      const keys = matching.slice(start, end);

      const page: MemoryStoreListPage = { keys };
      if (end < matching.length && keys.length > 0) {
        page.nextCursor = keys[keys.length - 1];
      }
      return page;
    },
  };
}

// ── Toy Sensor implementation ──────────────────────────────────────────────

/**
 * Manually-driven LifecycleSensor — `start`/`stop` flip an `active` flag,
 * and `emit()` fans the signal out to subscribers iff the sensor is
 * active. This keeps the test deterministic (no timers).
 *
 * `options.onStop` lets a test observe / influence the `stop()` call —
 * used by the unregisterSensor / clearSensors tests below to assert
 * that lifecycle hooks are awaited and that rejections are swallowed.
 */
function createToySensor(
  id: string,
  options?: { onStop?: () => Promise<void> | void },
): LifecycleSensor & {
  emit(signal: LifecycleSignal): void;
  active: boolean;
  stopCount: number;
} {
  const handlers = new Set<(signal: LifecycleSignal) => void>();
  let active = false;
  let stopCount = 0;

  const sensor: LifecycleSensor & {
    emit(signal: LifecycleSignal): void;
    active: boolean;
    stopCount: number;
  } = {
    id,
    get active() {
      return active;
    },
    set active(v: boolean) {
      active = v;
    },
    get stopCount() {
      return stopCount;
    },
    set stopCount(v: number) {
      stopCount = v;
    },
    start() {
      active = true;
    },
    async stop() {
      stopCount += 1;
      if (options?.onStop) {
        await options.onStop();
      }
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
function createRangeBaseline(id: string): LifecycleBaseline {
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

afterEach(async () => {
  // Each registry test starts from a clean slate — earlier failures must
  // not leak sensors into later runs. `clearSensors()` is async because it
  // awaits each registered sensor's `stop()`.
  await clearSensors();
});

describe("LifecycleMemoryStore (in-memory implementation)", () => {
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
    expect(all.keys.sort()).toEqual(["alpha", "beta"]);
    // No more pages when nothing was paginated.
    expect(all.nextCursor).toBeUndefined();

    // list with prefix filters
    await store.write("alpha:nested", 42);
    const filtered = await store.list("alpha");
    expect(filtered.keys.sort()).toEqual(["alpha", "alpha:nested"]);

    // delete removes the key
    await store.delete("alpha");
    expect(await store.read("alpha")).toBeNull();
    const afterDelete = await store.list();
    expect(afterDelete.keys.sort()).toEqual(["alpha:nested", "beta"]);

    // delete on missing key is a no-op
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });

  test("respects ttlMs on write", async () => {
    const store = createInMemoryStore();
    await store.write("ephemeral", "soon-gone", { ttlMs: 1 });

    // Wait past the TTL — Bun's setTimeout resolution is fine for 1ms.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await store.read("ephemeral")).toBeNull();
    const page = await store.list();
    expect(page.keys).not.toContain("ephemeral");
  });

  test("list supports cursor + limit pagination", async () => {
    const store = createInMemoryStore();

    // Seed 5 keys under the same prefix; the in-memory impl sorts them so
    // the cursor is deterministic across pages.
    for (const key of ["k:1", "k:2", "k:3", "k:4", "k:5"]) {
      await store.write(key, key);
    }

    // First page (limit 2).
    const page1 = await store.list("k:", { limit: 2 });
    expect(page1.keys).toEqual(["k:1", "k:2"]);
    expect(page1.nextCursor).toBeDefined();

    // Second page using the returned cursor.
    const page2 = await store.list("k:", { limit: 2, cursor: page1.nextCursor });
    expect(page2.keys).toEqual(["k:3", "k:4"]);
    expect(page2.nextCursor).toBeDefined();

    // Final page has < limit keys and no nextCursor.
    const page3 = await store.list("k:", { limit: 2, cursor: page2.nextCursor });
    expect(page3.keys).toEqual(["k:5"]);
    expect(page3.nextCursor).toBeUndefined();

    // Calling past the end returns an empty page with no cursor.
    const page4 = await store.list("k:", { limit: 2, cursor: page3.keys[0] });
    expect(page4.keys).toEqual([]);
    expect(page4.nextCursor).toBeUndefined();
  });
});

describe("LifecycleSensor + sensor-registry slot", () => {
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

  test("unregisterSensor removes the entry and reports success", async () => {
    const sensor = createToySensor("toy.unreg");
    registerSensor(sensor);

    expect(await unregisterSensor("toy.unreg")).toBe(true);
    expect(findSensor("toy.unreg")).toBeUndefined();

    // second call is a no-op
    expect(await unregisterSensor("toy.unreg")).toBe(false);
  });

  test("unregisterSensor awaits sensor.stop() before removing the entry", async () => {
    // Track ordering: the resolved-after flag must be set BEFORE the entry
    // is removed from the registry.
    let stopResolved = false;
    let entryWhenStopResolved: LifecycleSensor | undefined;

    const sensor = createToySensor("toy.stop-awaited", {
      async onStop() {
        // Yield to the microtask queue so we can prove the unregister call
        // is genuinely awaiting rather than firing-and-forgetting.
        await new Promise((resolve) => setTimeout(resolve, 5));
        // While stop() is still in flight, the entry must still exist.
        entryWhenStopResolved = findSensor("toy.stop-awaited");
        stopResolved = true;
      },
    });
    await sensor.start();
    registerSensor(sensor);

    const removed = await unregisterSensor("toy.stop-awaited");

    expect(stopResolved).toBe(true);
    // Sensor was still registered while stop() was running.
    expect(entryWhenStopResolved).toBe(sensor);
    expect(sensor.stopCount).toBe(1);
    expect(removed).toBe(true);
    // After the await, the entry has been removed.
    expect(findSensor("toy.stop-awaited")).toBeUndefined();
  });

  test("unregisterSensor swallows stop() rejections and still removes the sensor", async () => {
    const sensor = createToySensor("toy.stop-rejects", {
      async onStop() {
        throw new Error("boom");
      },
    });
    registerSensor(sensor);

    // The call must resolve (not reject) even though stop() threw.
    await expect(unregisterSensor("toy.stop-rejects")).resolves.toBe(true);
    expect(findSensor("toy.stop-rejects")).toBeUndefined();
    expect(sensor.stopCount).toBe(1);
  });

  test("clearSensors awaits stop() on every registered sensor", async () => {
    const a = createToySensor("toy.clear-a");
    const b = createToySensor("toy.clear-b", {
      async onStop() {
        // Force ordering: b's stop completes after a microtask hop.
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    const c = createToySensor("toy.clear-c", {
      async onStop() {
        throw new Error("c blew up");
      },
    });
    registerSensor(a);
    registerSensor(b);
    registerSensor(c);

    await clearSensors();

    expect(getSensors()).toEqual([]);
    // Every sensor's stop() was invoked exactly once, including the one
    // that rejected.
    expect(a.stopCount).toBe(1);
    expect(b.stopCount).toBe(1);
    expect(c.stopCount).toBe(1);
  });

  test("subscribe receives signals emitted while the sensor is started", async () => {
    const sensor = createToySensor("toy.emit");
    registerSensor(sensor);

    const received: LifecycleSignal[] = [];
    const unsub: Unsubscribe = sensor.subscribe((s) => received.push(s));

    // Before start, emit is dropped.
    sensor.emit({ source: "test", kind: "noop", data: null, timestamp: 0 });
    expect(received).toEqual([]);

    // After start, signals flow.
    await sensor.start();
    const signal: LifecycleSignal = {
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
    const after: LifecycleSignal[] = [];
    sensor.subscribe((s) => after.push(s));
    sensor.emit({ ...signal, kind: "post-stop" });
    expect(after).toEqual([]);
  });
});

describe("LifecycleBaseline (toy implementation)", () => {
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
