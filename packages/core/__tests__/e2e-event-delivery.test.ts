/**
 * E2E Test: Full event delivery lifecycle
 *
 * Tests event registration, emission, handler dispatch, ordering, and
 * error isolation using a real EventBus with InMemory backends.
 *
 * Covers:
 * - Register handler -> emit event -> handler receives it
 * - Multiple handlers for same event type
 * - Handler filtering by event type (non-matching events not received)
 * - Error in one handler doesn't break others
 * - Event ordering via priority
 */

import { describe, expect, it } from "bun:test";
import { createEventBus } from "../src/event/event-bus";
import type { EventHandlerDefinition, EventRecord } from "../src/types/event";

// ── Helpers ───────────────────────────────────────────────────

function makeEvent(type: string, payload: Record<string, unknown> = {}): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "test-system" },
    executionId: crypto.randomUUID(),
    payload,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("E2E: Event delivery lifecycle", () => {
  describe("Basic handler registration and dispatch", () => {
    it("registered handler receives a matching event", async () => {
      const { registry, bus } = createEventBus();
      const received: EventRecord[] = [];

      registry.register({
        name: "on-record-created",
        listen: "record.created",
        handler: async (event) => {
          received.push(event);
        },
      });

      const event = makeEvent("record.created", { schema: "task", recordId: "123" });
      await bus.emit(event);

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("record.created");
      expect(received[0].payload.schema).toBe("task");
    });

    it("handler does NOT receive non-matching event types", async () => {
      const { registry, bus } = createEventBus();
      const received: EventRecord[] = [];

      registry.register({
        name: "on-created-only",
        listen: "record.created",
        handler: async (event) => {
          received.push(event);
        },
      });

      await bus.emit(makeEvent("record.updated", { schema: "task" }));
      await bus.emit(makeEvent("record.deleted", { schema: "task" }));

      expect(received).toHaveLength(0);
    });

    it("handler receives shallow copy, not original event reference", async () => {
      const { registry, bus } = createEventBus();
      let receivedEvent: EventRecord | undefined;

      registry.register({
        name: "on-any",
        listen: "action.succeeded",
        handler: async (event) => {
          receivedEvent = event;
        },
      });

      const original = makeEvent("action.succeeded", { action: "create" });
      await bus.emit(original);

      expect(receivedEvent).toBeDefined();
      expect(receivedEvent).not.toBe(original); // shallow copy
      expect(receivedEvent).toEqual(original);
    });
  });

  describe("Multiple handlers for same event type", () => {
    it("all registered handlers receive the event", async () => {
      const { registry, bus } = createEventBus();
      const receivedBy: string[] = [];

      registry.register({
        name: "handler-1",
        listen: "record.created",
        handler: async () => {
          receivedBy.push("handler-1");
        },
      });

      registry.register({
        name: "handler-2",
        listen: "record.created",
        handler: async () => {
          receivedBy.push("handler-2");
        },
      });

      registry.register({
        name: "handler-3",
        listen: "record.created",
        handler: async () => {
          receivedBy.push("handler-3");
        },
      });

      await bus.emit(makeEvent("record.created"));

      expect(receivedBy).toHaveLength(3);
      expect(receivedBy.sort()).toEqual(["handler-1", "handler-2", "handler-3"]);
    });

    it("only handlers matching the event type receive the event (mixed registrations)", async () => {
      const { registry, bus } = createEventBus();
      const received: Record<string, number> = {};

      for (const name of ["on-created", "on-updated"]) {
        const eventType = name === "on-created" ? "record.created" : "record.updated";
        registry.register({
          name,
          listen: eventType,
          handler: async () => {
            received[name] = (received[name] ?? 0) + 1;
          },
        });
      }

      await bus.emit(makeEvent("record.created"));
      await bus.emit(makeEvent("record.created"));
      await bus.emit(makeEvent("record.updated"));

      expect(received["on-created"]).toBe(2);
      expect(received["on-updated"]).toBe(1);
    });
  });

  describe("Handler filtering by payload fields", () => {
    it("filter restricts handler to matching payload fields", async () => {
      const { registry, bus } = createEventBus();
      const received: string[] = [];

      registry.register({
        name: "task-only",
        listen: "record.created",
        filter: { schema: "task" },
        handler: async (event) => {
          received.push(event.payload.schema as string);
        },
      });

      await bus.emit(makeEvent("record.created", { schema: "task" }));
      await bus.emit(makeEvent("record.created", { schema: "purchase" }));
      await bus.emit(makeEvent("record.created", { schema: "task" }));

      expect(received).toHaveLength(2);
      expect(received).toEqual(["task", "task"]);
    });
  });

  describe("Error isolation", () => {
    it("error in one sync handler stops subsequent handlers (propagation)", async () => {
      const { registry, bus } = createEventBus();
      const receivedBy: string[] = [];

      registry.register({
        name: "failing-handler",
        listen: "record.created",
        priority: 10, // runs first
        handler: async () => {
          throw new Error("handler error");
        },
      });

      registry.register({
        name: "later-handler",
        listen: "record.created",
        priority: 20, // runs after failing-handler
        handler: async () => {
          receivedBy.push("later-handler");
        },
      });

      // Sync handlers: error in first propagates out of emit()
      await expect(bus.emit(makeEvent("record.created"))).rejects.toThrow("handler error");
      // Later sync handler did not run
      expect(receivedBy).toHaveLength(0);
    });

    it("error in async handler is swallowed (fire-and-forget)", async () => {
      const { registry, bus } = createEventBus();
      const received: string[] = [];

      registry.register({
        name: "async-failing",
        listen: "record.created",
        async: true,
        handler: async () => {
          throw new Error("async handler error");
        },
      });

      registry.register({
        name: "sync-ok",
        listen: "record.created",
        async: false,
        handler: async () => {
          received.push("sync-ok");
        },
      });

      // Async errors do not propagate — emit resolves normally
      await expect(bus.emit(makeEvent("record.created"))).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
    });
  });

  describe("Event ordering via priority", () => {
    it("lower priority number executes first", async () => {
      const { registry, bus } = createEventBus();
      const executionOrder: number[] = [];

      for (const [name, priority] of [
        ["low-priority", 200],
        ["high-priority", 10],
        ["medium-priority", 100],
      ] as [string, number][]) {
        registry.register({
          name,
          listen: "record.created",
          priority,
          handler: async () => {
            executionOrder.push(priority);
          },
        });
      }

      await bus.emit(makeEvent("record.created"));

      expect(executionOrder).toEqual([10, 100, 200]);
    });
  });

  describe("Event log", () => {
    it("getEmittedEvents returns all dispatched events in order", async () => {
      const { bus } = createEventBus();

      const e1 = makeEvent("record.created");
      const e2 = makeEvent("record.updated");
      const e3 = makeEvent("record.deleted");

      await bus.emit(e1);
      await bus.emit(e2);
      await bus.emit(e3);

      const log = bus.getEmittedEvents();
      expect(log).toHaveLength(3);
      expect(log[0].type).toBe("record.created");
      expect(log[1].type).toBe("record.updated");
      expect(log[2].type).toBe("record.deleted");
    });

    it("clear() empties the event log", async () => {
      const { bus } = createEventBus();

      await bus.emit(makeEvent("record.created"));
      await bus.emit(makeEvent("record.updated"));

      bus.clear();
      expect(bus.getEmittedEvents()).toHaveLength(0);
    });
  });

  describe("Handler with multiple event types", () => {
    it("handler that listens to array of event types receives all matching types", async () => {
      const { registry, bus } = createEventBus();
      const receivedTypes: string[] = [];

      registry.register({
        name: "multi-listener",
        listen: ["record.created", "record.deleted"],
        handler: async (event) => {
          receivedTypes.push(event.type);
        },
      });

      await bus.emit(makeEvent("record.created"));
      await bus.emit(makeEvent("record.updated")); // not in listen list
      await bus.emit(makeEvent("record.deleted"));

      expect(receivedTypes).toEqual(["record.created", "record.deleted"]);
    });
  });

  describe("Subscribe/unsubscribe", () => {
    it("subscribe adds a listener that receives events", async () => {
      const { bus } = createEventBus();
      const received: EventRecord[] = [];

      bus.subscribe("action.succeeded", (event) => {
        received.push(event);
      });

      await bus.emit(makeEvent("action.succeeded"));
      await bus.emit(makeEvent("action.failed"));

      // Give async handlers time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("action.succeeded");
    });

    it("unsubscribe stops handler from receiving subsequent events", async () => {
      const { bus } = createEventBus();
      const received: EventRecord[] = [];

      const unsubscribe = bus.subscribe("record.created", (event) => {
        received.push(event);
      });

      await bus.emit(makeEvent("record.created"));

      // Give async handlers time to run
      await new Promise((r) => setTimeout(r, 10));

      unsubscribe();

      await bus.emit(makeEvent("record.created"));
      await new Promise((r) => setTimeout(r, 10));

      // Only the first event was received
      expect(received).toHaveLength(1);
    });
  });
});
