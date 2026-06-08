import { describe, expect, test } from "bun:test";
import { createEvolutionScheduler, MIN_INTERVAL_MS } from "../../engine/evolution-scheduler";

/** A logger stub that records nothing (keeps test output clean). */
const SILENT = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as const;

describe("createEvolutionScheduler", () => {
  test("is inert until start() — constructing does not tick", async () => {
    let calls = 0;
    const s = createEvolutionScheduler({
      tick: () => {
        calls += 1;
      },
      intervalMs: 1000,
      logger: SILENT,
    });
    expect(s.isRunning()).toBe(false);
    // Give a microtask turn — still nothing should have run.
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  test("runOnce runs the tick and reports it ran", async () => {
    let calls = 0;
    const s = createEvolutionScheduler({
      tick: () => {
        calls += 1;
      },
      intervalMs: 1000,
      logger: SILENT,
    });
    const ran = await s.runOnce();
    expect(ran).toBe(true);
    expect(calls).toBe(1);
  });

  test("ticks are NON-OVERLAPPING — a second runOnce while one is in flight is skipped", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = createEvolutionScheduler({
      tick: async () => {
        calls += 1;
        await gate; // hold the tick open
      },
      intervalMs: 1000,
      logger: SILENT,
    });

    const first = s.runOnce(); // starts, blocks on the gate
    expect(s.isTicking()).toBe(true);
    const second = await s.runOnce(); // in-flight → skipped
    expect(second).toBe(false);
    expect(calls).toBe(1);

    release?.();
    expect(await first).toBe(true);
    expect(s.isTicking()).toBe(false);

    // Once the first finished, a later runOnce runs again.
    expect(await s.runOnce()).toBe(true);
    expect(calls).toBe(2);
  });

  test("a throwing tick is caught and routed to onError; scheduler keeps working", async () => {
    let errs = 0;
    const s = createEvolutionScheduler({
      tick: () => {
        throw new Error("cycle boom");
      },
      intervalMs: 1000,
      logger: SILENT,
      onError: () => {
        errs += 1;
      },
    });
    const ran = await s.runOnce(); // ran (and failed) — caught
    expect(ran).toBe(true);
    expect(errs).toBe(1);
    expect(s.isTicking()).toBe(false); // flag reset after the throw
  });

  test("runImmediately fires a tick on start; stop() halts and is reflected in isRunning", async () => {
    let calls = 0;
    const s = createEvolutionScheduler({
      tick: () => {
        calls += 1;
      },
      intervalMs: 1000,
      runImmediately: true,
      logger: SILENT,
    });
    s.start();
    expect(s.isRunning()).toBe(true);
    // Let the immediate runOnce microtask settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    s.stop();
    expect(s.isRunning()).toBe(false);
  });

  test("start() is idempotent — a second call does not stack timers", () => {
    const s = createEvolutionScheduler({ tick: () => {}, intervalMs: 1000, logger: SILENT });
    s.start();
    s.start();
    expect(s.isRunning()).toBe(true);
    s.stop();
    expect(s.isRunning()).toBe(false);
  });

  test("a non-finite or sub-floor interval is floored to MIN_INTERVAL_MS (no throw)", () => {
    // Behavioral smoke: construction with a bad interval must not throw and the
    // floor const is exported for callers to reference.
    expect(MIN_INTERVAL_MS).toBeGreaterThan(0);
    const s = createEvolutionScheduler({
      tick: () => {},
      intervalMs: Number.NaN,
      logger: SILENT,
    });
    s.start();
    expect(s.isRunning()).toBe(true);
    s.stop();
  });
});
