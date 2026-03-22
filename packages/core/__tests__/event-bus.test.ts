import { describe, expect, it } from "bun:test";
import { createEventBus } from "../src/engine/event-bus";
import type { EventHandlerDefinition, EventRecord } from "../src/types/event";

// ── Test helpers ────────────────────────────────────────────

function makeEvent(type: string, payload: Record<string, unknown> = {}): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: crypto.randomUUID(),
    payload,
  };
}

function makeHandler(
  overrides: Partial<EventHandlerDefinition> & { name: string; listen: string | string[] },
): EventHandlerDefinition {
  return {
    handler: async () => {},
    ...overrides,
  };
}

// ── Registry tests ──────────────────────────────────────────

describe("EventHandlerRegistry", () => {
  it("registers and retrieves a handler by name", () => {
    const { registry } = createEventBus();
    const handler = makeHandler({ name: "on-create", listen: "record.created" });
    registry.register(handler);

    expect(registry.get("on-create")).toBe(handler);
  });

  it("returns undefined for unknown handler name", () => {
    const { registry } = createEventBus();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered handlers", () => {
    const { registry } = createEventBus();
    registry.register(makeHandler({ name: "h1", listen: "a" }));
    registry.register(makeHandler({ name: "h2", listen: "b" }));

    expect(registry.getAll()).toHaveLength(2);
  });

  it("throws on duplicate handler name", () => {
    const { registry } = createEventBus();
    registry.register(makeHandler({ name: "h1", listen: "a" }));

    expect(() => registry.register(makeHandler({ name: "h1", listen: "b" }))).toThrow(
      "already registered",
    );
  });

  it("gets handlers by event type", () => {
    const { registry } = createEventBus();
    registry.register(makeHandler({ name: "h1", listen: "record.created" }));
    registry.register(makeHandler({ name: "h2", listen: "record.updated" }));
    registry.register(makeHandler({ name: "h3", listen: "record.created" }));

    const matched = registry.getByEvent("record.created");
    expect(matched).toHaveLength(2);
    expect(matched.map((h) => h.name).sort()).toEqual(["h1", "h3"]);
  });
});

// ── Emit tests ──────────────────────────────────────────────

describe("EventBus.emit", () => {
  it("handler receives matching event", async () => {
    const { registry, bus } = createEventBus();
    const received: EventRecord[] = [];

    registry.register(
      makeHandler({
        name: "listener",
        listen: "action.succeeded",
        handler: async (event) => {
          received.push(event);
        },
      }),
    );

    const event = makeEvent("action.succeeded", { action: "create" });
    await bus.emit(event);

    expect(received).toHaveLength(1);
    // Event is shallow-copied per handler, so not the same reference
    expect(received[0]).not.toBe(event);
    expect(received[0]).toEqual(event);
  });

  it("handler does NOT receive non-matching event", async () => {
    const { registry, bus } = createEventBus();
    const received: EventRecord[] = [];

    registry.register(
      makeHandler({
        name: "listener",
        listen: "action.succeeded",
        handler: async (event) => {
          received.push(event);
        },
      }),
    );

    await bus.emit(makeEvent("action.failed"));

    expect(received).toHaveLength(0);
  });

  it("multiple handlers execute in priority order", async () => {
    const { registry, bus } = createEventBus();
    const order: string[] = [];

    registry.register(
      makeHandler({
        name: "low-priority",
        listen: "test.event",
        priority: 200,
        handler: async () => {
          order.push("low");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "high-priority",
        listen: "test.event",
        priority: 10,
        handler: async () => {
          order.push("high");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "default-priority",
        listen: "test.event",
        handler: async () => {
          order.push("default");
        },
      }),
    );

    await bus.emit(makeEvent("test.event"));

    expect(order).toEqual(["high", "default", "low"]);
  });

  it("filter matching works (simple payload field matching)", async () => {
    const { registry, bus } = createEventBus();
    const received: string[] = [];

    registry.register(
      makeHandler({
        name: "filtered",
        listen: "record.created",
        filter: { schema: "product" },
        handler: async () => {
          received.push("filtered");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "unfiltered",
        listen: "record.created",
        handler: async () => {
          received.push("unfiltered");
        },
      }),
    );

    // Event with matching payload
    await bus.emit(makeEvent("record.created", { schema: "product", recordId: "1" }));
    expect(received).toEqual(["filtered", "unfiltered"]);

    received.length = 0;

    // Event with non-matching payload
    await bus.emit(makeEvent("record.created", { schema: "order", recordId: "2" }));
    expect(received).toEqual(["unfiltered"]);
  });

  it("sync handler error stops execution chain", async () => {
    const { registry, bus } = createEventBus();
    const executed: string[] = [];

    registry.register(
      makeHandler({
        name: "first",
        listen: "test.event",
        priority: 1,
        handler: async () => {
          executed.push("first");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "failing",
        listen: "test.event",
        priority: 2,
        handler: async () => {
          throw new Error("handler failed");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "third",
        listen: "test.event",
        priority: 3,
        handler: async () => {
          executed.push("third");
        },
      }),
    );

    await expect(bus.emit(makeEvent("test.event"))).rejects.toThrow("handler failed");
    expect(executed).toEqual(["first"]);
  });

  it("async handler errors don't block", async () => {
    const { registry, bus } = createEventBus();
    const executed: string[] = [];

    registry.register(
      makeHandler({
        name: "async-failing",
        listen: "test.event",
        priority: 1,
        async: true,
        handler: async () => {
          throw new Error("async failure");
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "sync-after",
        listen: "test.event",
        priority: 2,
        handler: async () => {
          executed.push("sync-after");
        },
      }),
    );

    // Should not throw despite async handler failing
    await bus.emit(makeEvent("test.event"));
    expect(executed).toEqual(["sync-after"]);
  });

  it("handler listening to multiple event types", async () => {
    const { registry, bus } = createEventBus();
    const received: string[] = [];

    registry.register(
      makeHandler({
        name: "multi-listener",
        listen: ["record.created", "record.updated"],
        handler: async (event) => {
          received.push(event.type);
        },
      }),
    );

    await bus.emit(makeEvent("record.created"));
    await bus.emit(makeEvent("record.updated"));
    await bus.emit(makeEvent("record.deleted"));

    expect(received).toEqual(["record.created", "record.updated"]);
  });
});

// ── Recursion guard tests ────────────────────────────────────

describe("EventBus recursion guard", () => {
  it("stops recursive emission via ctx.emit beyond maxDepth", async () => {
    const { registry, bus } = createEventBus();

    // Handler that re-emits the same event type via ctx.emit (fire-and-forget)
    registry.register(
      makeHandler({
        name: "recursive",
        listen: "loop.event",
        handler: async (_event, ctx) => {
          ctx.emit("loop.event", {});
        },
      }),
    );

    await bus.emit(makeEvent("loop.event"));

    // Wait a tick for fire-and-forget re-emissions to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Without the depth guard this would grow unbounded.
    // With default maxDepth=10 the log should be capped.
    const log = bus.getEmittedEvents();
    expect(log.length).toBeLessThanOrEqual(10);
    expect(log.length).toBeGreaterThan(1);
  });

  it("throws directly when emit depth exceeds maxDepth in sync path", async () => {
    const { registry, bus } = createEventBus();

    // Handler that directly awaits bus.emit (sync recursion path)
    registry.register(
      makeHandler({
        name: "sync-recursive",
        listen: "loop.sync",
        handler: async () => {
          await bus.emit(makeEvent("loop.sync"));
        },
      }),
    );

    await expect(bus.emit(makeEvent("loop.sync"))).rejects.toThrow("max emit depth");
  });

  it("handler mutation does not affect subsequent handlers", async () => {
    const { registry, bus } = createEventBus();
    const payloads: Record<string, unknown>[] = [];

    registry.register(
      makeHandler({
        name: "mutator",
        listen: "test.event",
        priority: 1,
        handler: async (event) => {
          event.payload.injected = true;
          payloads.push({ ...event.payload });
        },
      }),
    );

    registry.register(
      makeHandler({
        name: "reader",
        listen: "test.event",
        priority: 2,
        handler: async (event) => {
          payloads.push({ ...event.payload });
        },
      }),
    );

    await bus.emit(makeEvent("test.event", { original: true }));

    // First handler mutated its copy
    expect(payloads[0].injected).toBe(true);
    // Second handler got a clean copy without the mutation
    expect(payloads[1].injected).toBeUndefined();
    expect(payloads[1].original).toBe(true);
  });
});

// ── Event log tests ─────────────────────────────────────────

describe("EventBus event log", () => {
  it("emitted events are recorded", async () => {
    const { bus } = createEventBus();

    await bus.emit(makeEvent("event.one"));
    await bus.emit(makeEvent("event.two"));

    const log = bus.getEmittedEvents();
    expect(log).toHaveLength(2);
    expect(log[0].type).toBe("event.one");
    expect(log[1].type).toBe("event.two");
  });

  it("event log is cleared", async () => {
    const { bus } = createEventBus();

    await bus.emit(makeEvent("event.one"));
    expect(bus.getEmittedEvents()).toHaveLength(1);

    bus.clear();
    expect(bus.getEmittedEvents()).toHaveLength(0);
  });
});
