import { describe, expect, it } from "bun:test";
import { EventHandlerRegistry } from "../src/engine/event-bus";
import { PersistentEventBus, createPersistentEventBus } from "../src/engine/persistent-event-bus";
import { EventBus } from "../src/engine/event-bus";
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

/**
 * Create a mock database that captures insert/update calls.
 * This avoids needing a real PostgreSQL connection for unit tests.
 */
function createMockDb() {
  const insertedRows: Record<string, unknown>[] = [];
  const updatedRows: { id: string; set: Record<string, unknown> }[] = [];
  let insertShouldFail = false;

  const mockDb = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (insertShouldFail) {
          return {
            returning: () => Promise.reject(new Error("DB insert failed")),
          };
        }
        const id = crypto.randomUUID();
        insertedRows.push({ ...row, id });
        return {
          returning: () => Promise.resolve([{ id }]),
        };
      },
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: () => {
          updatedRows.push({ id: "mock", set: data });
          return Promise.resolve();
        },
      }),
    }),
    _setInsertFailure: (fail: boolean) => {
      insertShouldFail = fail;
    },
  };

  return { mockDb, insertedRows, updatedRows };
}

// ── Class structure tests ────────────────────────────────────

describe("PersistentEventBus structure", () => {
  it("extends EventBus", () => {
    const { mockDb } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
    expect(bus).toBeInstanceOf(EventBus);
    expect(bus).toBeInstanceOf(PersistentEventBus);
  });

  it("has emit method", () => {
    const { mockDb } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
    expect(typeof bus.emit).toBe("function");
  });

  it("createPersistentEventBus returns registry and bus", () => {
    const { mockDb } = createMockDb();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const result = createPersistentEventBus(mockDb as any);
    expect(result.registry).toBeInstanceOf(EventHandlerRegistry);
    expect(result.bus).toBeInstanceOf(PersistentEventBus);
  });
});

// ── In-memory handler tests (inherited behavior) ─────────────

describe("PersistentEventBus in-memory handlers", () => {
  it("handler receives matching event", async () => {
    const { mockDb } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
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

    await bus.emit(makeEvent("action.succeeded", { action: "create" }));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("action.succeeded");
  });

  it("handler does NOT receive non-matching event", async () => {
    const { mockDb } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
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
    const { mockDb } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
    const order: string[] = [];

    registry.register(
      makeHandler({
        name: "low",
        listen: "test.event",
        priority: 200,
        handler: async () => {
          order.push("low");
        },
      }),
    );
    registry.register(
      makeHandler({
        name: "high",
        listen: "test.event",
        priority: 10,
        handler: async () => {
          order.push("high");
        },
      }),
    );

    await bus.emit(makeEvent("test.event"));
    expect(order).toEqual(["high", "low"]);
  });
});

// ── Persistence tests (mock DB) ──────────────────────────────

describe("PersistentEventBus persistence", () => {
  it("inserts event into database on emit", async () => {
    const { mockDb, insertedRows } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);

    await bus.emit(makeEvent("record.created", { action: "create_order" }));

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].eventType).toBe("record.created");
    expect(insertedRows[0].status).toBe("pending");
  });

  it("updates status to completed on success", async () => {
    const { mockDb, updatedRows } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);

    await bus.emit(makeEvent("record.created"));

    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0].set.status).toBe("completed");
    expect(updatedRows[0].set.processedAt).toBeInstanceOf(Date);
  });

  it("updates status to failed when handler throws", async () => {
    const { mockDb, updatedRows } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);

    registry.register(
      makeHandler({
        name: "failing",
        listen: "test.event",
        handler: async () => {
          throw new Error("handler error");
        },
      }),
    );

    await expect(bus.emit(makeEvent("test.event"))).rejects.toThrow("handler error");

    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0].set.status).toBe("failed");
  });

  it("continues event processing when DB insert fails", async () => {
    const { mockDb } = createMockDb();
    mockDb._setInsertFailure(true);

    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);
    const received: string[] = [];

    registry.register(
      makeHandler({
        name: "listener",
        listen: "test.event",
        handler: async () => {
          received.push("handled");
        },
      }),
    );

    // Should not throw despite DB failure
    await bus.emit(makeEvent("test.event"));
    expect(received).toEqual(["handled"]);
  });

  it("extracts sourceAction from payload.action", async () => {
    const { mockDb, insertedRows } = createMockDb();
    const registry = new EventHandlerRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: mock db for testing
    const bus = new PersistentEventBus(mockDb as any, registry);

    await bus.emit(makeEvent("action.succeeded", { action: "approve_order" }));

    expect(insertedRows[0].sourceAction).toBe("approve_order");
  });
});

// NOTE: Integration tests with a real PostgreSQL database are needed
// to verify actual SQL persistence, table creation, and status updates.
// Those should be placed in a separate integration test suite that
// requires a running database instance.
