/**
 * Chatter auto-log event handler tests
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createChatterAutoLog } from "../src/event-handler";
import { InMemoryChatterService } from "../src/service";
import type { EventRecord } from "@linchkit/core";

// Stub EventHandlerContext (not used by handler, but required by signature)
const stubCtx = {
  execute: mock(async () => ({})),
  emit: mock(() => {}),
  get: mock(async () => ({})),
  query: mock(async () => []),
};

function makeEvent(type: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt-001",
    type,
    category: "change",
    timestamp: new Date(),
    actor: { type: "user", id: "user-001" },
    executionId: "exec-001",
    payload: {},
    schema: "purchase_request",
    recordId: "rec-001",
    ...overrides,
  };
}

describe("createChatterAutoLog", () => {
  let service: InMemoryChatterService;

  beforeEach(() => {
    service = new InMemoryChatterService();
  });

  it("logs record.created events", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(makeEvent("record.created"), stubCtx as never);

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(1);
    expect(result.items[0].body).toBe("Created this record.");
    expect(result.items[0].logEvent).toBe("record.created");
    expect(result.items[0].messageType).toBe("log");
    expect(result.items[0].authorId).toBe("user-001");
  });

  it("logs record.updated events with field diff", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("record.updated", {
        payload: {
          changedFields: ["amount", "vendor"],
          _old: { amount: 5000, vendor: "Acme" },
          _new: { amount: 8000, vendor: "GlobalCo" },
        },
      }),
      stubCtx as never,
    );

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(1);
    const msg = result.items[0];
    expect(msg.logEvent).toBe("record.updated");
    expect(msg.body).toContain("amount");
    expect(msg.body).toContain("5000");
    expect(msg.body).toContain("8000");
    expect(msg.body).toContain("vendor");
    expect((msg.logMetadata as Record<string, unknown>)?.changed_fields).toEqual(["amount", "vendor"]);
  });

  it("skips record.updated when only system fields changed", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("record.updated", {
        payload: {
          changedFields: ["updated_at", "_version"],
          _old: { updated_at: "2026-01-01", _version: 1 },
          _new: { updated_at: "2026-01-02", _version: 2 },
        },
      }),
      stubCtx as never,
    );

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(0);
  });

  it("skips record.updated when changedFields is empty", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("record.updated", {
        payload: { changedFields: [], _old: {}, _new: {} },
      }),
      stubCtx as never,
    );

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(0);
  });

  it("logs record.deleted events", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(makeEvent("record.deleted"), stubCtx as never);

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(1);
    expect(result.items[0].body).toBe("Deleted this record.");
    expect(result.items[0].logEvent).toBe("record.deleted");
  });

  it("logs state.transition events", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("state.transition", {
        payload: { from: "draft", to: "submitted", action: "submit_request" },
      }),
      stubCtx as never,
    );

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(1);
    const msg = result.items[0];
    expect(msg.body).toContain("draft");
    expect(msg.body).toContain("submitted");
    expect(msg.logEvent).toBe("state.transition");
    expect((msg.logMetadata as Record<string, unknown>)?.from).toBe("draft");
    expect((msg.logMetadata as Record<string, unknown>)?.to).toBe("submitted");
  });

  it("skips events without schema/recordId", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("record.created", { schema: undefined, recordId: undefined }),
      stubCtx as never,
    );

    // No messages should have been created
    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(0);
  });

  it("supports before/after payload convention (spec 53)", async () => {
    const handler = createChatterAutoLog(service);
    await handler.handler(
      makeEvent("record.updated", {
        payload: {
          changedFields: ["status"],
          before: { status: "draft" },
          after: { status: "approved" },
        },
      }),
      stubCtx as never,
    );

    const result = await service.getMessages("purchase_request", "rec-001");
    expect(result.totalCount).toBe(1);
    expect(result.items[0].body).toContain("status");
  });
});
