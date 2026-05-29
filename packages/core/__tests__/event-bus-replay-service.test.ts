import { describe, expect, it } from "bun:test";
import { createEventBus, EventBus, EventHandlerRegistry } from "../src/event/event-bus";
import {
  createEventBusReplayService,
  type EventBusReplayMeta,
} from "../src/event/event-bus-replay-service";
import type { EventRecord } from "../src/types/event";

// ── Helpers ──────────────────────────────────────────────────

function makeEvent(
  type: string,
  executionId: string,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId,
    payload: { key: "value" },
    ...overrides,
  };
}

function makeSetup() {
  const { registry, bus } = createEventBus();
  const replay = createEventBusReplayService(bus, registry);
  return { registry, bus, replay };
}

// ── Tests ────────────────────────────────────────────────────

describe("createEventBusReplayService", () => {
  it("returns a service with replayById and replayByExecution", () => {
    const { replay } = makeSetup();
    expect(typeof replay.replayById).toBe("function");
    expect(typeof replay.replayByExecution).toBe("function");
  });
});

describe("replayById — dry-run (default)", () => {
  it("returns not_found when event ID is not in log", async () => {
    const { replay } = makeSetup();
    const result = await replay.replayById("nonexistent-id");

    expect(result.dryRun).toBe(true);
    expect(result.replayed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.events[0]?.status).toBe("skipped");
    expect(result.events[0]?.skipReason).toBe("not_found");
    expect(result.events[0]?.originEventId).toBe("nonexistent-id");
  });

  it("finds and reports handlers without firing them", async () => {
    const { registry, bus, replay } = makeSetup();
    const calls: string[] = [];

    registry.register({
      name: "h1",
      listen: "record.created",
      handler: async () => {
        calls.push("h1");
      },
    });
    registry.register({
      name: "h2",
      listen: "record.created",
      handler: async () => {
        calls.push("h2");
      },
    });

    const event = makeEvent("record.created", "exec-1");
    await bus.emit(event);
    calls.length = 0; // reset after initial emit

    const result = await replay.replayById(event.id);

    expect(result.dryRun).toBe(true);
    expect(result.replayed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.events[0]?.status).toBe("replayed");
    expect(result.events[0]?.originEventId).toBe(event.id);
    expect(result.events[0]?.eventType).toBe("record.created");
    expect(result.events[0]?.handlers.map((h) => h.handlerName)).toEqual(["h1", "h2"]);
    expect(result.events[0]?.replayEventId).toBeUndefined();

    // Dry-run must NOT invoke handlers
    expect(calls).toEqual([]);
  });

  it("has an empty handlers list when no handlers match the event type", async () => {
    const { bus, replay } = makeSetup();
    const event = makeEvent("unhandled.type", "exec-1");
    await bus.emit(event);

    const result = await replay.replayById(event.id);

    expect(result.replayed).toBe(1);
    expect(result.events[0]?.handlers).toEqual([]);
  });

  it("returns a stable replayId UUID", async () => {
    const { bus, replay } = makeSetup();
    const event = makeEvent("record.created", "exec-1");
    await bus.emit(event);

    const result = await replay.replayById(event.id);
    expect(result.replayId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("excludes handlers whose filter does not match the event payload", async () => {
    const { registry, bus, replay } = makeSetup();

    registry.register({
      name: "filtered-h",
      listen: "record.filtered",
      filter: { status: "active" },
      handler: async () => {},
    });
    registry.register({
      name: "unfiltered-h",
      listen: "record.filtered",
      handler: async () => {},
    });

    const event = makeEvent("record.filtered", "exec-filter", { payload: { status: "inactive" } });
    await bus.emit(event);

    const result = await replay.replayById(event.id);

    // filtered-h must not appear because payload.status !== "active"
    expect(result.events[0]?.handlers.map((h) => h.handlerName)).toEqual(["unfiltered-h"]);
  });

  it("reports handlers sorted by priority (lower number = higher priority)", async () => {
    const { registry, bus, replay } = makeSetup();

    registry.register({
      name: "low-prio",
      listen: "prio.test",
      priority: 200,
      handler: async () => {},
    });
    registry.register({
      name: "high-prio",
      listen: "prio.test",
      priority: 10,
      handler: async () => {},
    });
    registry.register({ name: "default-prio", listen: "prio.test", handler: async () => {} });

    const event = makeEvent("prio.test", "exec-prio");
    await bus.emit(event);

    const result = await replay.replayById(event.id);

    expect(result.events[0]?.handlers.map((h) => h.handlerName)).toEqual([
      "high-prio",
      "default-prio",
      "low-prio",
    ]);
  });
});

describe("replayById — live mode", () => {
  it("re-emits the event and calls handlers again", async () => {
    const { registry, bus, replay } = makeSetup();
    const calls: string[] = [];

    registry.register({
      name: "h1",
      listen: "record.created",
      handler: async () => {
        calls.push("h1");
      },
    });

    const event = makeEvent("record.created", "exec-1");
    await bus.emit(event);
    expect(calls).toEqual(["h1"]);
    calls.length = 0;

    const result = await replay.replayById(event.id, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.replayed).toBe(1);
    expect(result.events[0]?.replayEventId).toBeDefined();
    expect(result.events[0]?.replayEventId).not.toBe(event.id);

    // Handler was called again in live mode
    expect(calls).toEqual(["h1"]);
  });

  it("injects EventBusReplayMeta into handler context via ExecutionMeta", async () => {
    const { registry, bus, replay } = makeSetup();
    let capturedReplayMeta: EventBusReplayMeta | undefined;

    registry.register({
      name: "h1",
      listen: "record.updated",
      handler: async (_event, ctx) => {
        capturedReplayMeta = ctx.meta.get<EventBusReplayMeta>("replay");
      },
    });

    const event = makeEvent("record.updated", "exec-2");
    await bus.emit(event);
    capturedReplayMeta = undefined; // reset

    const result = await replay.replayById(event.id, { dryRun: false });

    expect(capturedReplayMeta).toBeDefined();
    expect(capturedReplayMeta?.originEventId).toBe(event.id);
    expect(capturedReplayMeta?.replayId).toBe(result.replayId);
    expect(capturedReplayMeta?.dryRun).toBe(false);
  });

  it("assigns a new ID to the replayed event so it is distinct in the log", async () => {
    const { registry, bus, replay } = makeSetup();
    let seenIds: string[] = [];

    registry.register({
      name: "id-tracker",
      listen: "state.changed",
      handler: async (event) => {
        seenIds.push(event.id);
      },
    });

    const event = makeEvent("state.changed", "exec-3");
    await bus.emit(event);
    seenIds = [];

    await replay.replayById(event.id, { dryRun: false });

    expect(seenIds).toHaveLength(1);
    expect(seenIds[0]).not.toBe(event.id);
  });

  it("assigns a unique idempotencyKey prefixed replay: when force:true", async () => {
    const { bus, replay } = makeSetup();

    const event = makeEvent("record.force", "exec-force", { idempotencyKey: "original-key" });
    await bus.emit(event);

    const result = await replay.replayById(event.id, { dryRun: false, force: true });

    const replayedId = result.events[0]?.replayEventId;
    expect(replayedId).toBeDefined();

    const replayedEvent = bus.getEmittedEvents().find((e) => e.id === replayedId);
    expect(replayedEvent?.idempotencyKey).toMatch(/^replay:/);
    expect(replayedEvent?.idempotencyKey).not.toBe("original-key");
  });

  it("skips events that fail to emit and captures the error in errors[]", async () => {
    const { bus, replay } = makeSetup();

    const event = makeEvent("emit.failing", "exec-err");
    await bus.emit(event);

    // biome-ignore lint/suspicious/noExplicitAny: test-only override to simulate emit failure
    (bus as any).emit = async () => {
      throw new Error("simulated dispatch error");
    };

    const result = await replay.replayById(event.id, { dryRun: false });

    expect(result.replayed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.events[0]?.status).toBe("skipped");
    expect(result.events[0]?.skipReason).toBe("emit_error");
    expect(result.events[0]?.errors).toEqual([
      { handlerName: "<emit>", message: "simulated dispatch error" },
    ]);
  });

  it("captures sync handler errors per-event without aborting the batch (Spec 66 §4)", async () => {
    const { registry, bus, replay } = makeSetup();
    const calls: string[] = [];

    registry.register({
      name: "good-handler",
      listen: "batch.test",
      handler: async () => {
        calls.push("good");
      },
    });
    registry.register({
      name: "bad-handler",
      listen: "batch.fail",
      handler: async () => {
        throw new Error("boom");
      },
    });

    const ok = makeEvent("batch.test", "exec-batch-err");
    const bad = makeEvent("batch.fail", "exec-batch-err");
    const ok2 = makeEvent("batch.test", "exec-batch-err");
    await bus.emit(ok);
    // Pre-emit bad without invoking the bad handler. Use a direct push instead
    // of emit so the failure surfaces only during replay, not during seeding.
    // biome-ignore lint/suspicious/noExplicitAny: access internal log for seeding
    (bus as any).eventLog.push(bad);
    await bus.emit(ok2);
    calls.length = 0;

    const result = await replay.replayByExecution("exec-batch-err", { dryRun: false });

    // Bad handler throws on its event but good events still replay.
    expect(result.replayed).toBe(2);
    expect(result.skipped).toBe(1);

    const badResult = result.events.find((e) => e.originEventId === bad.id);
    expect(badResult?.status).toBe("skipped");
    expect(badResult?.skipReason).toBe("emit_error");
    expect(badResult?.errors?.[0]?.message).toBe("boom");

    // Good events have an empty errors array (always present in live mode).
    const goodResults = result.events.filter((e) => e.status === "replayed");
    for (const r of goodResults) {
      expect(r.errors).toEqual([]);
    }

    // Good handlers actually ran for the two ok events.
    expect(calls).toEqual(["good", "good"]);
  });

  it("force:true bypasses dedup even when the original event had no explicit idempotencyKey (derived key collision)", async () => {
    // Build a bus with a dedup window long enough that the original event
    // would suppress the replay unless force:true rewrites the key.
    const registry = new EventHandlerRegistry();
    const bus = new EventBus({ registry, dedupWindow: 60_000 });
    const replay = createEventBusReplayService(bus, registry);

    const calls: string[] = [];
    registry.register({
      name: "dedup-target",
      listen: "derived.key.test",
      handler: async () => {
        calls.push("hit");
      },
    });

    // Note: makeEvent does NOT set idempotencyKey, so EventBus derives one as
    // `${executionId}:${type}` → "exec-derived:derived.key.test". A naive replay
    // would hit the dedup window and be suppressed.
    const event = makeEvent("derived.key.test", "exec-derived");
    await bus.emit(event);
    expect(calls).toEqual(["hit"]);
    calls.length = 0;

    // First, confirm force:false IS suppressed by the derived dedup key.
    const noForceResult = await replay.replayById(event.id, { dryRun: false });
    expect(noForceResult.replayed).toBe(1); // bus.emit doesn't throw on dedup, just returns
    expect(calls).toEqual([]); // …but the handler did NOT run

    // Now force:true rewrites the key so the replay actually re-dispatches.
    const forceResult = await replay.replayById(event.id, { dryRun: false, force: true });
    expect(forceResult.replayed).toBe(1);
    expect(calls).toEqual(["hit"]);

    const replayedId = forceResult.events[0]?.replayEventId;
    const replayedEvent = bus.getEmittedEvents().find((e) => e.id === replayedId);
    expect(replayedEvent?.idempotencyKey).toMatch(/^replay:/);
  });
});

describe("replayByExecution — dry-run (default)", () => {
  it("returns empty result when no events match the execution", async () => {
    const { replay } = makeSetup();
    const result = await replay.replayByExecution("nonexistent-exec");

    expect(result.replayed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("finds all events for an execution and reports their handlers", async () => {
    const { registry, bus, replay } = makeSetup();

    registry.register({
      name: "created-handler",
      listen: "record.created",
      handler: async () => {},
    });

    const execId = "exec-batch";
    const e1 = makeEvent("record.created", execId);
    const e2 = makeEvent("record.updated", execId);
    const eOther = makeEvent("record.created", "exec-other");

    await bus.emit(e1);
    await bus.emit(e2);
    await bus.emit(eOther);

    const result = await replay.replayByExecution(execId);

    expect(result.dryRun).toBe(true);
    expect(result.replayed).toBe(2);
    expect(result.events.map((e) => e.originEventId).sort()).toEqual([e1.id, e2.id].sort());

    const createdResult = result.events.find((e) => e.eventType === "record.created");
    expect(createdResult?.handlers.map((h) => h.handlerName)).toEqual(["created-handler"]);

    const updatedResult = result.events.find((e) => e.eventType === "record.updated");
    expect(updatedResult?.handlers).toEqual([]);
  });

  it("does not set truncated flag when events are within limit", async () => {
    const { bus, replay } = makeSetup();
    const execId = "exec-small";
    await bus.emit(makeEvent("record.created", execId));

    const result = await replay.replayByExecution(execId);
    expect(result.truncated).toBeUndefined();
    expect(result.totalAvailable).toBe(1);
  });

  it("dry-run results honor handler filter and priority order (parity with EventBus dispatch)", async () => {
    const { registry, bus, replay } = makeSetup();

    registry.register({
      name: "skip-filtered",
      listen: "filtered.prio",
      filter: { status: "active" },
      priority: 5,
      handler: async () => {},
    });
    registry.register({
      name: "low",
      listen: "filtered.prio",
      priority: 200,
      handler: async () => {},
    });
    registry.register({
      name: "high",
      listen: "filtered.prio",
      priority: 10,
      handler: async () => {},
    });
    registry.register({
      name: "default",
      listen: "filtered.prio",
      handler: async () => {},
    });

    const event = makeEvent("filtered.prio", "exec-fp", { payload: { status: "inactive" } });
    await bus.emit(event);

    const result = await replay.replayByExecution("exec-fp");

    // "skip-filtered" excluded by filter; rest sorted ascending by priority.
    expect(result.events[0]?.handlers.map((h) => h.handlerName)).toEqual([
      "high",
      "default",
      "low",
    ]);
    // Dry-run errors array is always present and empty.
    expect(result.events[0]?.errors).toEqual([]);
  });
});

describe("replayByExecution — truncation guard", () => {
  it("sets truncated:true and totalAvailable when events exceed MAX_EVENTS_PER_REPLAY", async () => {
    // Reach the 10k cap. We need an EventBus whose event log can hold > 10k
    // events; the default cap is 1000, so override.
    const registry = new EventHandlerRegistry();
    const bus = new EventBus({ registry, maxEventLogSize: 20_000 });
    const replay = createEventBusReplayService(bus, registry);

    const execId = "exec-huge";
    const TOTAL = 10_005;
    for (let i = 0; i < TOTAL; i++) {
      await bus.emit(makeEvent("bulk.event", execId));
    }

    const result = await replay.replayByExecution(execId);
    expect(result.truncated).toBe(true);
    expect(result.totalAvailable).toBe(TOTAL);
    expect(result.events.length).toBe(10_000);
  });
});

describe("replayByExecution — live mode", () => {
  it("re-emits all execution events with replay metadata", async () => {
    const { registry, bus, replay } = makeSetup();
    const seenMetas: Array<EventBusReplayMeta | undefined> = [];

    registry.register({
      name: "meta-collector",
      listen: "record.created",
      handler: async (_event, ctx) => {
        seenMetas.push(ctx.meta.get<EventBusReplayMeta>("replay"));
      },
    });

    const execId = "exec-live";
    const e1 = makeEvent("record.created", execId);
    const e2 = makeEvent("record.created", execId);

    await bus.emit(e1);
    await bus.emit(e2);
    seenMetas.length = 0;

    const result = await replay.replayByExecution(execId, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.replayed).toBe(2);
    expect(seenMetas).toHaveLength(2);

    // All events in the batch share the same replayId
    const replayIds = seenMetas.map((m) => m?.replayId);
    expect(replayIds[0]).toBe(result.replayId);
    expect(replayIds[1]).toBe(result.replayId);

    // Each origin ID points back to the source event
    const originIds = seenMetas.map((m) => m?.originEventId).sort();
    expect(originIds).toEqual([e1.id, e2.id].sort());
  });
});
