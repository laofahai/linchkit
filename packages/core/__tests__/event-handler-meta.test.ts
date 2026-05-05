/**
 * EventHandlerContext.meta — end-to-end propagation (Spec 65 §7, issue #216).
 *
 * Validates that an event handler observes the originating action's
 * ExecutionMeta on `ctx.meta`, including:
 *   - Caller-provided keys (e.g., `skip_notifications`).
 *   - System keys (e.g., `_execution_id`, `_channel`).
 *   - Empty meta when triggered without a meta argument.
 *
 * The handler runs against both the lifecycle event (`action.succeeded`) and
 * a custom event emitted via `ctx.emit` from inside the action handler.
 */

import { describe, expect, test } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { createEventBus } from "../src/event/event-bus";
import type { ActionDefinition, Actor } from "../src/types/action";
import { createTestDataProvider } from "./command-layer-helpers";

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

interface Capture {
  event: string;
  skipNotifications: unknown;
  source: unknown;
  metaSnapshot: Record<string, unknown>;
}

describe("EventHandlerContext.meta — action-emitted events", () => {
  test("handler reads caller meta key from action.succeeded", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const { registry: handlerRegistry, bus } = createEventBus();
    const executor = createActionExecutor({ dataProvider: dp, eventBus: bus });

    handlerRegistry.register({
      name: "succeeded-meta-reader",
      listen: "action.succeeded",
      handler: async (event, ctx) => {
        captures.push({
          event: event.type,
          skipNotifications: ctx.meta.get("skip_notifications"),
          source: ctx.meta.get("source"),
          metaSnapshot: ctx.meta.toJSON(),
        });
      },
    });

    const action: ActionDefinition = {
      name: "noop_action",
      entity: "item",
      label: "Noop",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => ({ ok: true }),
    };
    executor.registry.register(action);

    const layer = createCommandLayer({ executor });
    const result = await layer.execute({
      command: "noop_action",
      input: {},
      meta: { skip_notifications: true, source: "import" },
      actor: defaultActor,
      channel: "internal",
    });

    expect(result.success).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0].event).toBe("action.succeeded");
    expect(captures[0].skipNotifications).toBe(true);
    expect(captures[0].source).toBe("import");
    // System keys present from the root meta.
    expect(captures[0].metaSnapshot._channel).toBe("internal");
    expect(typeof captures[0].metaSnapshot._execution_id).toBe("string");
  });

  test("handler reads caller meta key from a ctx.emit custom event", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const { registry: handlerRegistry, bus } = createEventBus();
    const executor = createActionExecutor({ dataProvider: dp, eventBus: bus });

    handlerRegistry.register({
      name: "custom-meta-reader",
      listen: "purchase.requested",
      handler: async (event, ctx) => {
        captures.push({
          event: event.type,
          skipNotifications: ctx.meta.get("skip_notifications"),
          source: ctx.meta.get("source"),
          metaSnapshot: ctx.meta.toJSON(),
        });
      },
    });

    const action: ActionDefinition = {
      name: "raise_request",
      entity: "request",
      label: "Raise Request",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        ctx.emit("purchase.requested", { recordId: "req-1" });
        return { ok: true };
      },
    };
    executor.registry.register(action);

    const layer = createCommandLayer({ executor });
    const result = await layer.execute({
      command: "raise_request",
      input: {},
      meta: { skip_notifications: true, source: "external-api" },
      actor: defaultActor,
      channel: "internal",
    });

    expect(result.success).toBe(true);
    // Two events fired: action.succeeded (not subscribed) + purchase.requested (subscribed).
    const customEvents = captures.filter((c) => c.event === "purchase.requested");
    expect(customEvents).toHaveLength(1);
    expect(customEvents[0].skipNotifications).toBe(true);
    expect(customEvents[0].source).toBe("external-api");
  });

  test("handler observes empty meta when action invoked with no meta", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const { registry: handlerRegistry, bus } = createEventBus();
    const executor = createActionExecutor({ dataProvider: dp, eventBus: bus });

    handlerRegistry.register({
      name: "empty-meta-reader",
      listen: "action.succeeded",
      handler: async (event, ctx) => {
        captures.push({
          event: event.type,
          skipNotifications: ctx.meta.get("skip_notifications"),
          source: ctx.meta.get("source"),
          metaSnapshot: ctx.meta.toJSON(),
        });
      },
    });

    const action: ActionDefinition = {
      name: "minimal_action",
      entity: "item",
      label: "Minimal",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => ({ ok: true }),
    };
    executor.registry.register(action);

    // Direct executor call — no CommandLayer, so no `meta` is supplied at all.
    const result = await executor.execute("minimal_action", {}, defaultActor);

    expect(result.success).toBe(true);
    expect(captures).toHaveLength(1);
    // Caller-provided keys are absent (undefined), but system keys exist
    // (action engine always stamps `_channel` + `_execution_id` + `_depth`).
    expect(captures[0].skipNotifications).toBeUndefined();
    expect(captures[0].source).toBeUndefined();
    // No external keys leak in.
    const callerKeys = Object.keys(captures[0].metaSnapshot).filter((k) => !k.startsWith("_"));
    expect(callerKeys).toEqual([]);
  });

  test("handler observes truly empty meta when event is emitted directly to bus (no action)", async () => {
    const observed: { snapshot: Record<string, unknown>; missing: unknown }[] = [];
    const { registry: handlerRegistry, bus } = createEventBus();

    handlerRegistry.register({
      name: "system-event-reader",
      listen: "system.heartbeat",
      handler: async (_event, ctx) => {
        observed.push({
          snapshot: ctx.meta.toJSON(),
          missing: ctx.meta.get("anything"),
        });
      },
    });

    // Event emitted outside any action context — `meta` is omitted on the
    // envelope so the bus must default to an empty ExecutionMeta.
    await bus.emit({
      id: crypto.randomUUID(),
      type: "system.heartbeat",
      category: "runtime",
      timestamp: new Date(),
      actor: { type: "system", id: "scheduler" },
      executionId: crypto.randomUUID(),
      payload: {},
    });

    expect(observed).toHaveLength(1);
    expect(observed[0].snapshot).toEqual({});
    expect(observed[0].missing).toBeUndefined();
  });
});
