/**
 * cap-notification end-to-end wiring test.
 *
 * The existing `actions.test.ts` and `channels.test.ts` suites drive the
 * handler/channel against a hand-rolled fake `ActionContext` and a bespoke
 * in-test store — they never prove the capability works through the REAL
 * runtime wiring. This suite closes that gap.
 *
 * It assembles the genuine production pieces and nothing fake:
 *   - real `InMemoryStore`        — the production DataProvider
 *   - real `EntityRegistry`       — fed the real `notificationSchema`
 *   - real `EventBus`             — root-level pending-event flush
 *   - real `ActionExecutor`       — registered with the real `sendNotificationAction`
 *   - real `CommandLayer`         — the actual dispatch entry point (exposure +
 *                                   fail-closed actor-type permission slots run)
 *
 * The notification is dispatched through `commandLayer.execute(...)` (the same
 * path HTTP/CLI/MCP adapters use), then we assert three independent facts:
 *   1. the record was PERSISTED and is queryable back from the SAME real store
 *      with the expected fields;
 *   2. the in_app channel actually DELIVERED (result.delivered + matching id);
 *   3. the real EventBus flushed `notification.sent` to a real subscriber that
 *      RECORDS deliveries — i.e. the async event-driven side fired for real.
 *
 * No store, channel, context, or event bus is mocked.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Actor, EventRecord } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  createEventBus,
  EntityRegistry,
  type EventBus,
  InMemoryStore,
} from "@linchkit/core/server";
import { notificationSchema, sendNotificationAction } from "../src";

// ── Real wiring harness ─────────────────────────────────────

interface Harness {
  store: InMemoryStore;
  eventBus: EventBus;
  commandLayer: ReturnType<typeof createCommandLayer>;
  /** Records every `notification.sent` event the real EventBus flushes. */
  delivered: EventRecord[];
}

/**
 * Build the real runtime once per test. The notification schema is registered
 * on a real EntityRegistry and on the store so reads resolve real entity
 * metadata, and the executor is wired to a real EventBus whose subscriber
 * records the async-flushed `notification.sent` events.
 */
function buildHarness(): Harness {
  const store = new InMemoryStore();
  store.registerEntity(notificationSchema);

  const entityRegistry = new EntityRegistry();
  entityRegistry.register(notificationSchema);

  const { bus: eventBus } = createEventBus();
  const delivered: EventRecord[] = [];
  // Real subscriber standing in for a downstream consumer of the dispatch
  // signal (e.g. a UI badge refresher). `sync: true` so the flush completes
  // before commandLayer.execute(...) resolves — no arbitrary timers needed.
  eventBus.subscribe(
    "notification.sent",
    (event) => {
      delivered.push(event);
    },
    { sync: true },
  );

  const executor = createActionExecutor({ dataProvider: store, eventBus, entityRegistry });
  executor.registry.register(sendNotificationAction);

  const commandLayer = createCommandLayer({ executor });

  return { store, eventBus, commandLayer, delivered };
}

const SYSTEM_ACTOR: Actor = { type: "system", id: "scheduler-1", groups: [] };

let h: Harness;

beforeEach(() => {
  h = buildHarness();
});

// No afterEach: beforeEach builds a fresh Harness (new InMemoryStore +
// EventBus) before every test, so there is no shared state to tear down —
// and an afterEach would throw a masking TypeError if beforeEach ever failed.

// ── Tests ───────────────────────────────────────────────────

describe("cap-notification e2e (real store + real dispatch + real event flush)", () => {
  it("dispatches through CommandLayer → persists a queryable record → flushes notification.sent", async () => {
    const result = await h.commandLayer.execute({
      command: "send_notification",
      input: {
        recipient_id: "user-42",
        channel: "in_app",
        title: "Build finished",
        message: "Your deployment is live.",
        link: "/deployments/9",
        metadata: { deployment_id: "9" },
      },
      actor: SYSTEM_ACTOR,
      channel: "internal",
    });

    // 1. The action succeeded and the in_app channel reported real delivery.
    expect(result.success).toBe(true);
    const dispatch = result.data as { channel: string; delivered: boolean; id: string | null };
    expect(dispatch.channel).toBe("in_app");
    expect(dispatch.delivered).toBe(true);
    expect(typeof dispatch.id).toBe("string");

    // 2. The record is PERSISTED and queryable back from the SAME real store,
    //    by the same query path the read side (GraphQL) uses.
    const rows = await h.store.query("notification", { recipient_id: "user-42" });
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.id).toBe(dispatch.id as string);
    expect(row).toMatchObject({
      recipient_id: "user-42",
      channel: "in_app",
      title: "Build finished",
      message: "Your deployment is live.",
      link: "/deployments/9",
      metadata: { deployment_id: "9" },
      read_at: null,
    });
    // System fields are server-managed — prove the store stamped them.
    expect(typeof row.created_at).toBe("string");

    // 3. The real EventBus flushed notification.sent to the real subscriber.
    expect(h.delivered).toHaveLength(1);
    const event = h.delivered[0] as EventRecord;
    expect(event.type).toBe("notification.sent");
    expect(event.payload).toMatchObject({
      recipient_id: "user-42",
      channel: "in_app",
      notification_id: dispatch.id as string,
    });
  });

  it("does NOT persist or flush when an undelivered (stub) channel is used", async () => {
    const result = await h.commandLayer.execute({
      command: "send_notification",
      input: { recipient_id: "user-7", channel: "email", message: "hi" },
      actor: SYSTEM_ACTOR,
      channel: "internal",
    });

    expect(result.success).toBe(true);
    const dispatch = result.data as { channel: string; delivered: boolean };
    expect(dispatch.delivered).toBe(false);

    // No row persisted, no event flushed — the real negative path.
    const rows = await h.store.query("notification", {});
    expect(rows).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
  });

  it("is blocked by the real pipeline for a human actor (no record, no flush)", async () => {
    const result = await h.commandLayer.execute({
      command: "send_notification",
      input: { recipient_id: "user-9", channel: "in_app", message: "spoofed" },
      actor: { type: "human", id: "attacker", groups: [] },
      channel: "internal",
    });

    // The executor's fail-closed actor-type check rejects human callers.
    expect(result.success).toBe(false);

    const rows = await h.store.query("notification", {});
    expect(rows).toHaveLength(0);
    expect(h.delivered).toHaveLength(0);
  });
});
