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
import { defineWatcher, type WatcherStateEntry } from "@linchkit/core";
import { createWatcherRegistry, type WatcherRegistry } from "@linchkit/core/server";
import {
  createWatcherEngine,
  type WatcherActionExecutor,
  type WatcherEngine,
} from "../src/watcher-engine";
import { InMemoryWatcherStateStore } from "../src/watcher-state-store";

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

    // The mutation was mirrored to the store.
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
    expect(await store.load()).toHaveLength(1);

    // Reset clears the cache AND the store (write-through).
    engineA.resetState("low-stock-persisted", "item-1");
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
});
