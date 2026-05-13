import { describe, expect, it } from "bun:test";
import { EventBus, EventHandlerRegistry } from "../src/event/event-bus";
import type { EventHandlerDefinition, EventRecord } from "../src/types/event";

// ── Helpers ─────────────────────────────────────────────────

const EXEC_A = "exec-aaa";
const EXEC_B = "exec-bbb";

function makeEvent(
  type: string,
  executionId: string = EXEC_A,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId,
    payload: {},
    ...overrides,
  };
}

function makeHandler(name: string, listen: string, calls: string[]): EventHandlerDefinition {
  return {
    name,
    listen,
    handler: async () => {
      calls.push(name);
    },
  };
}

function makeBusWithDedup(dedupWindow: number): { registry: EventHandlerRegistry; bus: EventBus } {
  const registry = new EventHandlerRegistry();
  const bus = new EventBus({ registry, dedupWindow });
  return { registry, bus };
}

// ── Tests ────────────────────────────────────────────────────

describe("EventBus deduplication — disabled by default", () => {
  it("same executionId+type dispatches twice when dedup is off", async () => {
    const registry = new EventHandlerRegistry();
    const bus = new EventBus({ registry }); // dedupWindow not set
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    const evt = makeEvent("record.created");
    await bus.emit(evt);
    await bus.emit({ ...evt, id: crypto.randomUUID() }); // same executionId+type

    expect(calls).toHaveLength(2);
  });
});

describe("EventBus deduplication — enabled", () => {
  it("first emission dispatches handlers", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    await bus.emit(makeEvent("record.created", EXEC_A));

    expect(calls).toHaveLength(1);
  });

  it("second emission with same executionId+type is suppressed", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    const evt = makeEvent("record.created", EXEC_A);
    await bus.emit(evt);
    await bus.emit({ ...evt, id: crypto.randomUUID() }); // different event id, same exec+type

    expect(calls).toHaveLength(1);
  });

  it("different event type with same executionId is not suppressed", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));
    registry.register(makeHandler("h2", "record.updated", calls));

    await bus.emit(makeEvent("record.created", EXEC_A));
    await bus.emit(makeEvent("record.updated", EXEC_A)); // different type → not a dup

    expect(calls).toHaveLength(2);
  });

  it("different executionId with same type is not suppressed", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    await bus.emit(makeEvent("record.created", EXEC_A));
    await bus.emit(makeEvent("record.created", EXEC_B)); // different execution

    expect(calls).toHaveLength(2);
  });

  it("explicit idempotencyKey takes precedence over derived key", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    // Two events from different executions but same explicit key → second suppressed
    await bus.emit(makeEvent("record.created", EXEC_A, { idempotencyKey: "custom-key-1" }));
    await bus.emit(makeEvent("record.created", EXEC_B, { idempotencyKey: "custom-key-1" }));

    expect(calls).toHaveLength(1);
  });

  it("different explicit idempotencyKeys are each dispatched once", async () => {
    const { registry, bus } = makeBusWithDedup(5 * 60 * 1000);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    await bus.emit(makeEvent("record.created", EXEC_A, { idempotencyKey: "key-x" }));
    await bus.emit(makeEvent("record.created", EXEC_A, { idempotencyKey: "key-y" }));

    expect(calls).toHaveLength(2);
  });

  it("dedupStoreSize increases after first emission", async () => {
    const { bus } = makeBusWithDedup(5 * 60 * 1000);
    expect(bus.dedupStoreSize).toBe(0);

    await bus.emit(makeEvent("record.created", EXEC_A));
    expect(bus.dedupStoreSize).toBe(1);

    // Duplicate suppressed — size stays 1
    await bus.emit(makeEvent("record.created", EXEC_A));
    expect(bus.dedupStoreSize).toBe(1);
  });

  it("dedup window expiry: expired entry is not treated as duplicate", async () => {
    // Use a very short window (1 ms) to simulate expiry
    const { registry, bus } = makeBusWithDedup(1);
    const calls: string[] = [];
    registry.register(makeHandler("h1", "record.created", calls));

    await bus.emit(makeEvent("record.created", EXEC_A));

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Expiry is now checked per-key on access (not just at lazy-prune time).
    // Re-emitting EXEC_A after the window expires should dispatch the handler.
    await bus.emit(makeEvent("record.created", EXEC_A));

    // 1 (first) + 1 (re-dispatched after expiry) = 2
    expect(calls).toHaveLength(2);
  });

  it("suppressed event is not recorded in eventLog", async () => {
    // Dedup suppression happens before emitDepth++, so the suppressed event
    // does NOT enter the event log. Verify this explicit contract.
    const { bus } = makeBusWithDedup(5 * 60 * 1000);

    await bus.emit(makeEvent("record.created", EXEC_A));
    await bus.emit(makeEvent("record.created", EXEC_A)); // suppressed

    // Only the first event entered the log
    expect(bus.getEmittedEvents()).toHaveLength(1);
  });
});
