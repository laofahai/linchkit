/**
 * Unit tests for watcher debounce-state persistence (Spec 45 §4).
 *
 * Covers:
 * - InMemoryWatcherStateStore round-trips (load / set / delete / clearForWatcher)
 * - The headline RESTART-SAFETY guarantee: a watcher driven to a debounced
 *   `once_until_reset` state, then a fresh WatcherEngine constructed sharing the
 *   SAME store, must NOT re-fire after re-hydrating — proving debounce state
 *   survives a process restart (the bug this PR fixes).
 * - Write-through on resetState (so a restart does not resurrect cleared state).
 *
 * No database required — exercises only the in-memory store + engine wiring.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  defineWatcher,
  type EventBusLike,
  type EventRecord,
  type WatcherStateEntry,
} from "@linchkit/core";
import { createWatcherRegistry, type WatcherRegistry } from "@linchkit/core/server";
import {
  createWatcherEngine,
  type WatcherActionExecutor,
  type WatcherEngine,
} from "../src/watcher-engine";
import { InMemoryWatcherStateStore, type WatcherStateStore } from "../src/watcher-state-store";

// ── Helpers ──────────────────────────────────────────────

function createMockActionExecutor(): WatcherActionExecutor & {
  calls: Array<{ actionName: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ actionName: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async executeAction(actionName, input) {
      calls.push({ actionName, input });
      return { ok: true };
    },
  };
}

function lowStockOnceUntilReset() {
  return defineWatcher({
    name: "low-stock-persisted",
    watch: { entity: "inventory" },
    trigger: {
      type: "threshold",
      field: "quantity",
      condition: { lt: 10 },
      debounce: "once_until_reset",
    },
    effect: { action: "reorder", params: {} },
  });
}

// ── InMemoryWatcherStateStore round-trips ─────────────────

describe("InMemoryWatcherStateStore", () => {
  it("round-trips entries via set + load", async () => {
    const store = new InMemoryWatcherStateStore();
    const entry: WatcherStateEntry = {
      watcherName: "w1",
      groupKey: "item-1",
      lastFiredAt: new Date("2026-01-01T00:00:00Z"),
      conditionMet: true,
    };

    await store.set("w1", "item-1", entry);
    const loaded = await store.load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.watcherName).toBe("w1");
    expect(loaded[0]?.groupKey).toBe("item-1");
    expect(loaded[0]?.conditionMet).toBe(true);
    expect(loaded[0]?.lastFiredAt?.getTime()).toBe(new Date("2026-01-01T00:00:00Z").getTime());
  });

  it("set overwrites the entry for the same (watcher, groupKey)", async () => {
    const store = new InMemoryWatcherStateStore();
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: null,
      conditionMet: false,
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.conditionMet).toBe(false);
  });

  it("delete removes a single entry", async () => {
    const store = new InMemoryWatcherStateStore();
    await store.set("w1", "a", {
      watcherName: "w1",
      groupKey: "a",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w1", "b", {
      watcherName: "w1",
      groupKey: "b",
      lastFiredAt: null,
      conditionMet: true,
    });

    await store.delete("w1", "a");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.groupKey).toBe("b");
  });

  it("clearForWatcher removes only that watcher's entries", async () => {
    const store = new InMemoryWatcherStateStore();
    await store.set("w1", "a", {
      watcherName: "w1",
      groupKey: "a",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w1", "b", {
      watcherName: "w1",
      groupKey: "b",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w2", "a", {
      watcherName: "w2",
      groupKey: "a",
      lastFiredAt: null,
      conditionMet: true,
    });

    await store.clearForWatcher("w1");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.watcherName).toBe("w2");
  });

  it("load returns defensive copies (mutating a result does not corrupt the store)", async () => {
    const store = new InMemoryWatcherStateStore();
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: null,
      conditionMet: true,
    });

    const first = await store.load();
    const entry = first[0];
    if (entry) entry.conditionMet = false;

    const second = await store.load();
    expect(second[0]?.conditionMet).toBe(true);
  });

  it("clones the lastFiredAt Date on set + load (no shared Date reference)", async () => {
    const store = new InMemoryWatcherStateStore();
    const original = new Date("2026-01-01T00:00:00Z");

    // ── set path: the store must NOT share the caller's Date instance. ──
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: original,
      conditionMet: true,
    });
    // Mutate the caller's Date after handing it off.
    original.setFullYear(1999);

    const afterSetMutation = await store.load();
    expect(afterSetMutation[0]?.lastFiredAt?.getTime()).toBe(
      new Date("2026-01-01T00:00:00Z").getTime(),
    );

    // ── load path: each returned Date must be a distinct instance. ──
    const first = await store.load();
    const second = await store.load();
    expect(first[0]?.lastFiredAt).not.toBe(second[0]?.lastFiredAt);

    // Mutating a returned Date must not corrupt the stored state.
    first[0]?.lastFiredAt?.setFullYear(1999);
    const reread = await store.load();
    expect(reread[0]?.lastFiredAt?.getTime()).toBe(new Date("2026-01-01T00:00:00Z").getTime());
  });
});

// ── Write-through + restart simulation ────────────────────

describe("WatcherEngine — persistent debounce state (restart safety)", () => {
  let registry: WatcherRegistry;
  let store: InMemoryWatcherStateStore;
  let engineA: WatcherEngine | undefined;
  let engineB: WatcherEngine | undefined;

  afterEach(() => {
    engineA?.stop();
    engineB?.stop();
    engineA = undefined;
    engineB = undefined;
  });

  it("writes debounce state through to the configured store", async () => {
    registry = createWatcherRegistry();
    registry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();
    const executor = createMockActionExecutor();

    engineA = createWatcherEngine({ registry, actionExecutor: executor, stateStore: store });
    const r = await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(r[0]?.fired).toBe(true);

    // The mutation was mirrored to the store (write-through is serialized /
    // fire-and-forget → await it has drained before asserting durable state).
    await engineA.whenPersisted();
    const persisted = await store.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.watcherName).toBe("low-stock-persisted");
    expect(persisted[0]?.groupKey).toBe("item-1");
    expect(persisted[0]?.conditionMet).toBe(true);
  });

  it("does NOT re-fire after a simulated restart (new engine, same store, hydrated)", async () => {
    registry = createWatcherRegistry();
    registry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();
    const executorA = createMockActionExecutor();

    // ── Engine A: drive the once_until_reset watcher to its fired state ──
    engineA = createWatcherEngine({ registry, actionExecutor: executorA, stateStore: store });
    const r1 = await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(r1[0]?.fired).toBe(true);
    expect(executorA.calls).toHaveLength(1);

    // Same engine, same condition → debounced (does not re-fire).
    const r2 = await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 3 });
    expect(r2[0]?.fired).toBe(false);
    expect(executorA.calls).toHaveLength(1);

    // ── Simulated process restart: a brand-new engine, fresh in-memory cache,
    //    but sharing the SAME persistent store. It must restore debounce state. ──
    const executorB = createMockActionExecutor();
    engineB = createWatcherEngine({
      registry: createWatcherRegistry(),
      actionExecutor: executorB,
      stateStore: store,
    });
    // Hydrate from the store (this is what `start()` does on boot).
    await engineB.hydrate();

    // The restored state proves debounce survived the restart.
    const restored = engineB.getState("low-stock-persisted", "item-1");
    expect(restored).toBeDefined();
    expect(restored?.conditionMet).toBe(true);
    expect(restored?.lastFiredAt).toBeInstanceOf(Date);
  });

  it("after restart the watcher stays debounced and does not re-execute its effect", async () => {
    // Build a registry shared by both engine generations.
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();

    const executorA = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executorA,
      stateStore: store,
    });
    await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(executorA.calls).toHaveLength(1);

    // Restart: new engine on the same registry + same store.
    const executorB = createMockActionExecutor();
    engineB = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executorB,
      stateStore: store,
    });
    await engineB.hydrate();

    // Condition still met after restart → must be debounced, effect NOT re-run.
    const r = await engineB.evaluateAfterMutation("inventory", { id: "item-1", quantity: 2 });
    expect(r[0]?.fired).toBe(false);
    expect(r[0]?.reason).toBe("debounced");
    expect(executorB.calls).toHaveLength(0);
  });

  it("resetState write-through clears persisted state so it is not restored on restart", async () => {
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();

    const executorA = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executorA,
      stateStore: store,
    });
    await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    // Write-through is serialized/fire-and-forget → await it has drained.
    await engineA.whenPersisted();
    expect(await store.load()).toHaveLength(1);

    // Reset clears the cache AND the store (write-through).
    engineA.resetState("low-stock-persisted", "item-1");
    await engineA.whenPersisted();
    expect(await store.load()).toHaveLength(0);

    // Restarted engine hydrates an empty store → watcher fires fresh.
    const executorB = createMockActionExecutor();
    engineB = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executorB,
      stateStore: store,
    });
    await engineB.hydrate();

    const r = await engineB.evaluateAfterMutation("inventory", { id: "item-1", quantity: 4 });
    expect(r[0]?.fired).toBe(true);
    expect(executorB.calls).toHaveLength(1);
  });

  it("evaluation still completes when the store throws SYNCHRONOUSLY on write", async () => {
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());

    // A store whose write-through methods throw synchronously (not async
    // rejections). The engine's `mirror()` must swallow these so a faulty store
    // never disrupts the synchronous watcher-evaluation path.
    const errors: string[] = [];
    const throwingStore: WatcherStateStore = {
      async load() {
        return [];
      },
      set() {
        throw new Error("sync set boom");
      },
      delete() {
        throw new Error("sync delete boom");
      },
      clearForWatcher() {
        throw new Error("sync clear boom");
      },
    };

    const executor = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executor,
      stateStore: throwingStore,
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg: string) => errors.push(msg),
        debug: () => {},
      },
    });

    // Evaluation must complete normally and the effect must still fire, even
    // though the synchronous store write threw.
    const r = await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(r[0]?.fired).toBe(true);
    expect(executor.calls).toHaveLength(1);

    // resetState (which mirrors a delete) must also not throw.
    expect(() => engineA?.resetState("low-stock-persisted", "item-1")).not.toThrow();
    expect(() => engineA?.resetState("low-stock-persisted")).not.toThrow();

    // The synchronous failures were logged, not propagated.
    expect(errors.some((m) => m.includes("Failed to persist debounce state"))).toBe(true);
  });

  it("start() awaits hydration before evaluation when a store is configured", async () => {
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();

    // Seed the store directly as if a prior process had fired the watcher.
    await store.set("low-stock-persisted", "item-1", {
      watcherName: "low-stock-persisted",
      groupKey: "item-1",
      lastFiredAt: new Date(),
      conditionMet: true,
    });

    const executor = createMockActionExecutor();
    engineB = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executor,
      stateStore: store,
    });

    // start() returns a promise (store configured) — await it, then the seeded
    // debounce state must already be in the cache.
    await engineB.start();
    expect(engineB.getState("low-stock-persisted", "item-1")?.conditionMet).toBe(true);
  });

  it("does NOT start subsystems when stop() races an in-flight hydration", async () => {
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());

    // A store whose load() resolves only when we release the deferred — letting
    // us interleave a stop() while start()'s hydration is still in flight.
    let releaseLoad: (() => void) | undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const deferredStore: WatcherStateStore = {
      async load() {
        await loadGate;
        return [];
      },
      async set() {},
      async delete() {},
      async clearForWatcher() {},
    };

    // An event bus that records every subscription so we can prove subsystems
    // never bound after the racing stop().
    const subscribed: string[] = [];
    const eventBus: EventBusLike = {
      subscribe(eventType: string, _handler: (event: EventRecord) => Promise<void>) {
        subscribed.push(eventType);
        return () => {};
      },
    };

    const executor = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      eventBus,
      actionExecutor: executor,
      stateStore: deferredStore,
    });

    // Begin start() (awaits hydration) but do NOT await it yet.
    const startPromise = engineA.start();
    // Stop while hydration is still blocked on the deferred load.
    engineA.stop();
    // Now release hydration and let start() finish.
    releaseLoad?.();
    await startPromise;

    // Subsystems must NOT have bound any subscriptions after the racing stop().
    expect(subscribed).toHaveLength(0);
  });

  it("hydrate REPLACES the cache — a stale key absent from the store is dropped", async () => {
    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());
    store = new InMemoryWatcherStateStore();

    // The store initially holds both item-1 and a soon-to-be-stale key.
    await store.set("low-stock-persisted", "item-1", {
      watcherName: "low-stock-persisted",
      groupKey: "item-1",
      lastFiredAt: new Date(),
      conditionMet: true,
    });
    await store.set("low-stock-persisted", "stale-item", {
      watcherName: "low-stock-persisted",
      groupKey: "stale-item",
      lastFiredAt: new Date(),
      conditionMet: true,
    });

    const executor = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executor,
      stateStore: store,
    });

    // First hydrate loads BOTH keys into the cache.
    await engineA.hydrate();
    expect(engineA.getState("low-stock-persisted", "stale-item")).toBeDefined();

    // Delete the stale key from the store so it is absent on the NEXT hydrate,
    // while it still lingers in the cache (the bug Finding 3 fixes — a merge
    // would let the stale key keep suppressing the watcher).
    await store.delete("low-stock-persisted", "stale-item");

    // Re-hydrate (simulates a reused engine / stop()→start()) — it must REPLACE
    // (clear then load), so the stale key is gone and only item-1 survives.
    await engineA.hydrate();
    expect(engineA.getState("low-stock-persisted", "stale-item")).toBeUndefined();
    expect(engineA.getState("low-stock-persisted", "item-1")?.conditionMet).toBe(true);
  });

  it("serializes mirrored writes in submission order (slow set then fast delete ends deleted)", async () => {
    // A store stub that records apply order and makes set() slow + delete() fast.
    // Without serialization the fast delete would land before the slow set,
    // leaving the store in a (wrongly) resurrected state.
    const applied: Array<{ op: "set" | "delete"; key: string }> = [];
    const orderingStore: WatcherStateStore = {
      async load() {
        return [];
      },
      async set(watcherName, groupKey) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        applied.push({ op: "set", key: `${watcherName}:${groupKey}` });
      },
      async delete(watcherName, groupKey) {
        applied.push({ op: "delete", key: `${watcherName}:${groupKey}` });
      },
      async clearForWatcher(watcherName) {
        applied.push({ op: "delete", key: `${watcherName}:*` });
      },
    };

    const sharedRegistry = createWatcherRegistry();
    sharedRegistry.register(lowStockOnceUntilReset());
    const executor = createMockActionExecutor();
    engineA = createWatcherEngine({
      registry: sharedRegistry,
      actionExecutor: executor,
      stateStore: orderingStore,
    });

    // Enqueue a slow set (via evaluation → updateState → mirror set) immediately
    // followed by a fast delete (via resetState → mirror delete) for the SAME key.
    await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    engineA.resetState("low-stock-persisted", "item-1");

    // Wait for the serialized write chain to drain.
    await engineA.whenPersisted();

    // Writes must have applied in submission order: set THEN delete — so the
    // store ends in the deleted state. Without serialization the fast delete
    // would land before the slow set, leaving the store wrongly resurrected.
    expect(applied.map((a) => a.op)).toEqual(["set", "delete"]);
    expect(applied[applied.length - 1]?.op).toBe("delete");
  });
});
