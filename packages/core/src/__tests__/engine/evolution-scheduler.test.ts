import { describe, expect, test } from "bun:test";
import {
  createEvolutionScheduler,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
} from "../../engine/evolution-scheduler";

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

  test("an over-large interval is clamped to MAX_INTERVAL_MS (no setInterval 32-bit overflow)", () => {
    // A delay above 2^31-1 ms overflows setInterval's signed-32-bit field and is
    // coerced to 1ms — making a "once a month" cadence fire every millisecond.
    // The ceiling const keeps such a value as "effectively never fires".
    expect(MAX_INTERVAL_MS).toBe(2_147_483_647);
    let calls = 0;
    const s = createEvolutionScheduler({
      tick: () => {
        calls += 1;
      },
      intervalMs: Number.MAX_SAFE_INTEGER,
      logger: SILENT,
    });
    s.start();
    expect(s.isRunning()).toBe(true);
    // The clamped timer must NOT have fired synchronously (no overflow-to-1ms).
    expect(calls).toBe(0);
    s.stop();
  });
});

describe("EvolutionScheduler.getStatus", () => {
  test("a fresh scheduler reports an inert, never-ticked snapshot", () => {
    const s = createEvolutionScheduler({ tick: () => {}, intervalMs: 60_000, logger: SILENT });
    const status = s.getStatus();
    expect(status.running).toBe(false);
    expect(status.intervalMs).toBe(60_000); // the clamped interval actually in use
    expect(status.ticksStarted).toBe(0);
    expect(status.ticksCompleted).toBe(0);
    expect(status.lastTickStartedAt).toBeNull();
    expect(status.lastTickCompletedAt).toBeNull();
    expect(status.lastTickDurationMs).toBeNull();
    expect(status.lastError).toBeNull();
    expect(status.consecutiveErrors).toBe(0);
  });

  test("reports the CLAMPED interval, not the requested one", () => {
    // Below MIN floors up; above MAX clamps down. getStatus must reflect the
    // interval actually in use, not the raw requested value.
    expect(
      createEvolutionScheduler({ tick: () => {}, intervalMs: 1, logger: SILENT }).getStatus()
        .intervalMs,
    ).toBe(MIN_INTERVAL_MS);
    expect(
      createEvolutionScheduler({
        tick: () => {},
        intervalMs: Number.MAX_SAFE_INTEGER,
        logger: SILENT,
      }).getStatus().intervalMs,
    ).toBe(MAX_INTERVAL_MS);
  });

  test("after a tick fires, counters increment and timestamps populate", async () => {
    const s = createEvolutionScheduler({
      tick: async () => {
        // A tiny await so the completion timestamp can differ from the start one.
        await Promise.resolve();
      },
      intervalMs: 1000,
      logger: SILENT,
    });
    await s.runOnce();

    const status = s.getStatus();
    expect(status.ticksStarted).toBe(1);
    expect(status.ticksCompleted).toBe(1);
    expect(status.lastTickStartedAt).toBeInstanceOf(Date);
    expect(status.lastTickCompletedAt).toBeInstanceOf(Date);
    expect(status.lastTickDurationMs).not.toBeNull();
    expect(status.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    expect(status.lastError).toBeNull();
    expect(status.consecutiveErrors).toBe(0);
  });

  test("a throwing tick sets lastError + increments consecutiveErrors; a later OK tick resets it", async () => {
    let shouldThrow = true;
    const s = createEvolutionScheduler({
      tick: () => {
        if (shouldThrow) throw new Error("cycle boom");
      },
      intervalMs: 1000,
      logger: SILENT,
      onError: () => {}, // swallow — we assert via getStatus
    });

    // Two consecutive failures.
    await s.runOnce();
    await s.runOnce();
    let status = s.getStatus();
    expect(status.ticksStarted).toBe(2);
    expect(status.ticksCompleted).toBe(2); // a thrown tick still "completes"
    expect(status.lastError).toBe("cycle boom");
    expect(status.consecutiveErrors).toBe(2);

    // A subsequent OK tick clears the error streak.
    shouldThrow = false;
    await s.runOnce();
    status = s.getStatus();
    expect(status.lastError).toBeNull();
    expect(status.consecutiveErrors).toBe(0);
    expect(status.ticksCompleted).toBe(3);
  });

  test("getStatus is read-only — mutating the snapshot cannot corrupt internal state", async () => {
    const s = createEvolutionScheduler({ tick: () => {}, intervalMs: 1000, logger: SILENT });
    await s.runOnce();
    const snap = s.getStatus();
    // Mutate the returned Date and counter.
    snap.lastTickStartedAt?.setFullYear(1970);
    snap.ticksStarted = 999;
    const fresh = s.getStatus();
    expect(fresh.ticksStarted).toBe(1);
    expect(fresh.lastTickStartedAt?.getFullYear()).not.toBe(1970);
  });

  test("running flips true on start() and false on stop()", () => {
    const s = createEvolutionScheduler({ tick: () => {}, intervalMs: 1000, logger: SILENT });
    expect(s.getStatus().running).toBe(false);
    s.start();
    expect(s.getStatus().running).toBe(true);
    s.stop();
    expect(s.getStatus().running).toBe(false);
  });
});
