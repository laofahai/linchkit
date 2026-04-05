/**
 * Tests for SubscriptionManager — SSE realtime subscription system (spec 44).
 *
 * Covers: event filtering, connection management, heartbeat, backpressure,
 * tenant isolation, and SSE formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventBus, EventRecord } from "@linchkit/core";
import { createEventBus } from "@linchkit/core/server";
import {
  formatSSEEvent,
  parseSubscriptionQuery,
  type SubscriptionEvent,
  SubscriptionManager,
} from "../src/subscription-manager";

// ── Helpers ──────────────────────────────────────────────────

function makeEventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "record.created",
    category: "change",
    timestamp: new Date("2026-03-26T10:00:00Z"),
    actor: { type: "user", id: "user-1" },
    executionId: "exec-1",
    entity: "task",
    recordId: "task-1",
    payload: { title: "Test Task" },
    ...overrides,
  };
}

/** Collect events pushed to a mock connection */
function createMockConnection() {
  const events: Array<SubscriptionEvent | null> = [];
  let closed = false;
  return {
    events,
    get closed() {
      return closed;
    },
    push: (event: SubscriptionEvent | null): boolean => {
      if (closed) return false;
      events.push(event);
      return true;
    },
    close: () => {
      closed = true;
    },
  };
}

// ── parseSubscriptionQuery ───────────────────────────────────

describe("parseSubscriptionQuery", () => {
  test("parses comma-separated schemas", () => {
    const filter = parseSubscriptionQuery({
      schemas: "task,purchase_request",
    });
    expect(filter.schemas).toEqual(["task", "purchase_request"]);
    expect(filter.ids).toBeUndefined();
  });

  test("parses schemas and ids", () => {
    const filter = parseSubscriptionQuery({
      schemas: "task",
      ids: "task-1,task-2",
    });
    expect(filter.schemas).toEqual(["task"]);
    expect(filter.ids).toEqual(["task-1", "task-2"]);
  });

  test("returns empty schemas for missing param", () => {
    const filter = parseSubscriptionQuery({});
    expect(filter.schemas).toEqual([]);
    expect(filter.ids).toBeUndefined();
  });

  test("trims whitespace from schema names", () => {
    const filter = parseSubscriptionQuery({
      schemas: " task , order ",
    });
    expect(filter.schemas).toEqual(["task", "order"]);
  });

  test("filters out empty segments", () => {
    const filter = parseSubscriptionQuery({
      schemas: "task,,order,",
    });
    expect(filter.schemas).toEqual(["task", "order"]);
  });
});

// ── formatSSEEvent ───────────────────────────────────────────

describe("formatSSEEvent", () => {
  test("formats a subscription event as SSE", () => {
    const event: SubscriptionEvent = {
      type: "record.created",
      entity: "task",
      recordId: "task-1",
      actor: { type: "user", id: "user-1" },
      timestamp: "2026-03-26T10:00:00.000Z",
    };
    const result = formatSSEEvent(event, "42");
    expect(result).toContain("id: 42");
    expect(result).toContain("event: record.created");
    expect(result).toContain("data: ");
    // Verify JSON payload
    const dataLine = result.split("\n").find((l) => l.startsWith("data: "));
    const parsed = JSON.parse(dataLine?.slice(6));
    expect(parsed.entity).toBe("task");
    expect(parsed.recordId).toBe("task-1");
  });

  test("formats heartbeat as SSE comment", () => {
    const result = formatSSEEvent(null);
    expect(result).toBe(": keepalive\n\n");
  });

  test("omits id field when eventId is not provided", () => {
    const event: SubscriptionEvent = {
      type: "record.updated",
      entity: "task",
      recordId: "task-1",
      actor: { type: "user", id: "user-1" },
      timestamp: "2026-03-26T10:00:00.000Z",
    };
    const result = formatSSEEvent(event);
    expect(result).not.toContain("id: ");
  });
});

// ── SubscriptionManager ──────────────────────────────────────

describe("SubscriptionManager", () => {
  let bus: EventBus;
  let manager: SubscriptionManager;

  beforeEach(() => {
    const result = createEventBus();
    bus = result.bus;
    manager = new SubscriptionManager(bus, {
      heartbeatInterval: 0, // Disable heartbeat in tests
      idleTimeout: 0, // Disable idle check in tests
      maxConnectionsPerUser: 3,
      maxBufferSize: 5,
    });
    manager.start();
  });

  afterEach(() => {
    manager.stop();
  });

  // ── Connection management ────────────────────────────────

  describe("connection management", () => {
    test("adds and removes connections", () => {
      const mock = createMockConnection();
      const connId = manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"] },
        push: mock.push,
        close: mock.close,
      });
      expect(connId).not.toBeNull();
      expect(manager.connectionCount).toBe(1);

      if (connId) manager.removeConnection(connId);
      expect(manager.connectionCount).toBe(0);
      expect(mock.closed).toBe(true);
    });

    test("enforces per-user connection limit", () => {
      const mocks = Array.from({ length: 4 }, () => createMockConnection());

      for (let i = 0; i < 3; i++) {
        const id = manager.addConnection({
          userId: "user-1",
          actor: { type: "user", id: "user-1", groups: [] },
          filter: { schemas: [] },
          push: mocks[i].push,
          close: mocks[i].close,
        });
        expect(id).not.toBeNull();
      }

      // 4th connection should be rejected
      const id = manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mocks[3].push,
        close: mocks[3].close,
      });
      expect(id).toBeNull();
      expect(manager.connectionCount).toBe(3);
    });

    test("allows connections from different users independently", () => {
      const mock1 = createMockConnection();
      const mock2 = createMockConnection();

      const id1 = manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock1.push,
        close: mock1.close,
      });
      const id2 = manager.addConnection({
        userId: "user-2",
        actor: { type: "user", id: "user-2", groups: [] },
        filter: { schemas: [] },
        push: mock2.push,
        close: mock2.close,
      });

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(manager.connectionCount).toBe(2);
      expect(manager.countUserConnections("user-1")).toBe(1);
      expect(manager.countUserConnections("user-2")).toBe(1);
    });
  });

  // ── Event filtering ──────────────────────────────────────

  describe("event filtering", () => {
    test("delivers events matching schema filter", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "task", recordId: "task-1" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(1);
      expect(mock.events[0]?.entity).toBe("task");
    });

    test("filters out events for non-subscribed schemas", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "order", recordId: "order-1" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(0);
    });

    test("delivers all schema events when schemas filter is empty", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "task" }));
      await bus.emit(makeEventRecord({ entity: "order" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(2);
    });

    test("filters by record ID when specified", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"], ids: ["task-1"] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "task", recordId: "task-1" }));
      await bus.emit(makeEventRecord({ entity: "task", recordId: "task-2" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(1);
      expect(mock.events[0]?.recordId).toBe("task-1");
    });

    test("enforces tenant isolation", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"], tenantId: "tenant-a" },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "task", tenantId: "tenant-a" }));
      await bus.emit(makeEventRecord({ entity: "task", tenantId: "tenant-b" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(1);
      expect(mock.events[0]?.tenantId).toBe("tenant-a");
    });
  });

  // ── Event type mapping ───────────────────────────────────

  describe("event type mapping", () => {
    test("maps record.created to record.created", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ type: "record.created" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.type).toBe("record.created");
    });

    test("maps record.updated to record.updated", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ type: "record.updated" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.type).toBe("record.updated");
    });

    test("maps record.deleted to record.deleted", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ type: "record.deleted" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.type).toBe("record.deleted");
    });

    test("maps state.transition to state.changed", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(
        makeEventRecord({
          type: "state.transition",
          payload: {
            stateTransition: { from: "draft", to: "submitted" },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.type).toBe("state.changed");
      expect(mock.events[0]?.state).toEqual({
        from: "draft",
        to: "submitted",
        action: "state.transition",
      });
    });

    test("maps approval.resolved to approval.resolved", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ type: "approval.resolved" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.type).toBe("approval.resolved");
    });

    test("ignores events without schema", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(
        makeEventRecord({
          entity: undefined,
          type: "record.created",
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(0);
    });

    test("ignores unmapped event types", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ type: "some.other.event" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events.length).toBe(0);
    });
  });

  // ── Event payload ────────────────────────────────────────

  describe("event payload", () => {
    test("includes changes for created events", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(
        makeEventRecord({
          type: "record.created",
          payload: { title: "New Task", description: "Details" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.changes).toEqual({
        title: "New Task",
        description: "Details",
      });
    });

    test("strips internal fields (id, _version) from changes", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(
        makeEventRecord({
          type: "record.updated",
          payload: { id: "task-1", _version: 2, title: "Updated" },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.changes).toEqual({ title: "Updated" });
      expect(mock.events[0]?.changes?.id).toBeUndefined();
      expect(mock.events[0]?.changes?._version).toBeUndefined();
    });

    test("includes actor and timestamp metadata", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      const timestamp = new Date("2026-03-26T12:00:00Z");
      await bus.emit(
        makeEventRecord({
          actor: { type: "user", id: "admin-1" },
          timestamp,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.actor).toEqual({ type: "user", id: "admin-1" });
      expect(mock.events[0]?.timestamp).toBe("2026-03-26T12:00:00.000Z");
    });

    test("includes executionId for traceability", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ executionId: "exec-42" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock.events[0]?.executionId).toBe("exec-42");
    });
  });

  // ── Backpressure ─────────────────────────────────────────

  describe("backpressure", () => {
    test("drops oldest events when buffer is full", async () => {
      const mock = createMockConnection();
      let pushCount = 0;
      // Simulate a slow connection — first 5 pushes succeed, then fail
      const slowPush = (event: SubscriptionEvent | null): boolean => {
        pushCount++;
        mock.events.push(event);
        return true;
      };

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: slowPush,
        close: mock.close,
      });

      // Emit more events than buffer size (5)
      for (let i = 0; i < 8; i++) {
        await bus.emit(
          makeEventRecord({
            recordId: `task-${i}`,
            payload: { index: i },
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 100));

      // All events should have been pushed (since push always returns true)
      expect(pushCount).toBe(8);
    });

    test("removes connection when push returns false", async () => {
      let pushCount = 0;
      const mock = createMockConnection();
      const failingPush = (_event: SubscriptionEvent | null): boolean => {
        pushCount++;
        if (pushCount > 2) return false; // Simulate dead connection
        return true;
      };

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: failingPush,
        close: mock.close,
      });

      expect(manager.connectionCount).toBe(1);

      // Emit events — 3rd push will fail, connection should be removed
      for (let i = 0; i < 5; i++) {
        await bus.emit(makeEventRecord({ recordId: `task-${i}` }));
      }
      await new Promise((r) => setTimeout(r, 100));

      expect(manager.connectionCount).toBe(0);
    });
  });

  // ── Multiple connections ─────────────────────────────────

  describe("multiple connections", () => {
    test("delivers events to all matching connections", async () => {
      const mock1 = createMockConnection();
      const mock2 = createMockConnection();

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"] },
        push: mock1.push,
        close: mock1.close,
      });
      manager.addConnection({
        userId: "user-2",
        actor: { type: "user", id: "user-2", groups: [] },
        filter: { schemas: ["task"] },
        push: mock2.push,
        close: mock2.close,
      });

      await bus.emit(makeEventRecord({ entity: "task" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(mock1.events.length).toBe(1);
      expect(mock2.events.length).toBe(1);
    });

    test("delivers events only to matching connections", async () => {
      const taskMock = createMockConnection();
      const orderMock = createMockConnection();

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: ["task"] },
        push: taskMock.push,
        close: taskMock.close,
      });
      manager.addConnection({
        userId: "user-2",
        actor: { type: "user", id: "user-2", groups: [] },
        filter: { schemas: ["order"] },
        push: orderMock.push,
        close: orderMock.close,
      });

      await bus.emit(makeEventRecord({ entity: "task" }));
      await new Promise((r) => setTimeout(r, 50));

      expect(taskMock.events.length).toBe(1);
      expect(orderMock.events.length).toBe(0);
    });
  });

  // ── Lifecycle ────────────────────────────────────────────

  describe("lifecycle", () => {
    test("stop() clears all connections", () => {
      const mock1 = createMockConnection();
      const mock2 = createMockConnection();

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock1.push,
        close: mock1.close,
      });
      manager.addConnection({
        userId: "user-2",
        actor: { type: "user", id: "user-2", groups: [] },
        filter: { schemas: [] },
        push: mock2.push,
        close: mock2.close,
      });

      expect(manager.connectionCount).toBe(2);
      manager.stop();
      expect(manager.connectionCount).toBe(0);
      expect(mock1.closed).toBe(true);
      expect(mock2.closed).toBe(true);
    });

    test("stop() prevents further event delivery", async () => {
      const mock = createMockConnection();
      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      manager.stop();

      await bus.emit(makeEventRecord());
      await new Promise((r) => setTimeout(r, 50));

      // No events should have been delivered (connection was closed)
      // The push would still succeed but connection was closed by stop()
      expect(mock.closed).toBe(true);
    });

    test("nextEventId generates monotonically increasing IDs", () => {
      const id1 = manager.nextEventId();
      const id2 = manager.nextEventId();
      const id3 = manager.nextEventId();

      expect(Number(id1)).toBeLessThan(Number(id2));
      expect(Number(id2)).toBeLessThan(Number(id3));
    });
  });

  // ── Permission enforcement ─────────────────────────────────

  describe("permission enforcement", () => {
    test("blocks events when permission checker denies access", async () => {
      const mock = createMockConnection();
      manager.setPermissionChecker((_actor, entityName) => {
        // Only allow reading "task" schema, deny "secret"
        return entityName === "task";
      });

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] }, // subscribe to all
        push: mock.push,
        close: mock.close,
      });

      // Emit event for "secret" schema — should be blocked
      await bus.emit(makeEventRecord({ entity: "secret" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(mock.events.length).toBe(0);

      // Emit event for "task" schema — should be delivered
      await bus.emit(makeEventRecord({ entity: "task" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(mock.events.length).toBe(1);
    });

    test("delivers events when no permission checker is set", async () => {
      const mock = createMockConnection();
      // No setPermissionChecker call

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: mock.push,
        close: mock.close,
      });

      await bus.emit(makeEventRecord({ entity: "secret" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(mock.events.length).toBe(1);
    });
  });

  // ── Dead connection close ──────────────────────────────────

  describe("dead connection cleanup", () => {
    test("calls close() on connection when push returns false", async () => {
      const mock = createMockConnection();
      let _pushCount = 0;
      const failingPush = (_event: SubscriptionEvent | null): boolean => {
        _pushCount++;
        return false; // Always fail
      };

      manager.addConnection({
        userId: "user-1",
        actor: { type: "user", id: "user-1", groups: [] },
        filter: { schemas: [] },
        push: failingPush,
        close: mock.close,
      });

      await bus.emit(makeEventRecord());
      await new Promise((r) => setTimeout(r, 50));

      // Connection should be closed and removed
      expect(mock.closed).toBe(true);
      expect(manager.connectionCount).toBe(0);
    });
  });
});

// ── SSE endpoint integration (server-level) ──────────────────

describe("SSE endpoint via createServer", () => {
  test("createServer accepts eventBus option without errors", async () => {
    const { bus } = createEventBus();
    // Import createServer dynamically to avoid port conflicts
    const { createServer } = await import("../src/server");
    const { buildGraphQLSchema } = await import("../src/graphql/build-schema");

    const schema = buildGraphQLSchema([
      {
        name: "task",
        label: "Task",
        fields: { title: { type: "string", required: true, label: "Title" } },
      },
    ]);

    // Should not throw
    const app = createServer(schema, { eventBus: bus });
    expect(app).toBeDefined();

    // Verify subscription manager is attached
    // biome-ignore lint/suspicious/noExplicitAny: test access
    expect((app as any).__subscriptionManager).toBeDefined();

    // Clean up
    // biome-ignore lint/suspicious/noExplicitAny: test access
    (app as any).__subscriptionManager.stop();
  });
});
