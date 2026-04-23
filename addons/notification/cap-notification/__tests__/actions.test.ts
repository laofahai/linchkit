/**
 * cap-notification action handler tests.
 *
 * Each action is invoked through a minimal fake ActionContext so the tests
 * exercise handler logic (validation, data-provider calls, emitted events)
 * without pulling in the full command-layer pipeline.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { ActionDefinition } from "@linchkit/core";
import { markAllReadAction, markNotificationReadAction, sendNotificationAction } from "../src";

type Row = Record<string, unknown> & { id: string };

interface EmittedEvent {
  type: string;
  payload: Record<string, unknown>;
}

type ActorOverride = { id?: string; type?: string };

class FakeStore {
  public rows = new Map<string, Row>();
  public emitted: EmittedEvent[] = [];
  private seq = 0;

  ctx(input: Record<string, unknown>, actor: ActorOverride = {}) {
    return {
      input,
      actor: { id: actor.id ?? "actor-1", type: actor.type ?? "system", groups: [] },
      tenantId: "t-1",
      executionId: "exec-1",
      timestamp: new Date(),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      ai: {} as never,
      config: { get: () => undefined } as never,
      hasCapability: () => false,
      emit: (type: string, payload: Record<string, unknown>) => {
        this.emitted.push({ type, payload });
      },
      get: async (_entity: string, id: string) => {
        const row = this.rows.get(id);
        if (!row) throw new Error(`not found: ${id}`);
        return row;
      },
      query: async (_entity: string, filter: Record<string, unknown>) => {
        return [...this.rows.values()].filter((row) =>
          Object.entries(filter).every(([k, v]) => row[k] === v),
        );
      },
      create: async (_entity: string, data: Record<string, unknown>) => {
        this.seq += 1;
        const row: Row = { id: `n-${this.seq}`, ...data };
        this.rows.set(row.id, row);
        return row;
      },
      update: async (_entity: string, id: string, patch: Record<string, unknown>) => {
        const row = this.rows.get(id);
        if (!row) throw new Error(`not found: ${id}`);
        const updated: Row = { ...row, ...patch };
        this.rows.set(id, updated);
        return updated;
      },
      delete: async () => {},
      execute: async () => ({}),
    };
  }
}

function callHandler(action: ActionDefinition, ctxLike: unknown): Promise<unknown> {
  if (!action.handler) throw new Error(`action ${action.name} has no handler`);
  return action.handler(ctxLike as never);
}

describe("send_notification", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it("creates an in-app notification row and emits notification.sent (system actor)", async () => {
    const result = await callHandler(
      sendNotificationAction,
      store.ctx({ recipient_id: "user-1", message: "hi", channel: "in_app" }, { type: "system" }),
    );

    expect(result).toMatchObject({ channel: "in_app", delivered: true });
    expect(store.rows.size).toBe(1);
    const [row] = store.rows.values();
    expect(row).toMatchObject({
      recipient_id: "user-1",
      message: "hi",
      channel: "in_app",
      read_at: null,
    });
    expect(store.emitted).toContainEqual(
      expect.objectContaining({
        type: "notification.sent",
        payload: expect.objectContaining({ recipient_id: "user-1" }),
      }),
    );
  });

  it("defaults to the in_app channel when channel is omitted", async () => {
    const result = (await callHandler(
      sendNotificationAction,
      store.ctx({ recipient_id: "user-1", message: "hi" }, { type: "worker" }),
    )) as { channel: string; delivered: boolean };
    expect(result.channel).toBe("in_app");
    expect(result.delivered).toBe(true);
  });

  it("does NOT emit notification.sent for stub email channel (delivered=false)", async () => {
    const result = (await callHandler(
      sendNotificationAction,
      store.ctx({ recipient_id: "user-1", message: "hi", channel: "email" }, { type: "system" }),
    )) as { channel: string; delivered: boolean };
    expect(result.channel).toBe("email");
    expect(result.delivered).toBe(false);
    expect(store.emitted).toHaveLength(0);
  });

  it("rejects human / non-privileged actor types", async () => {
    await expect(
      callHandler(
        sendNotificationAction,
        store.ctx({ recipient_id: "user-1", message: "hi" }, { type: "human" }),
      ),
    ).rejects.toThrow(/system dispatch primitive/i);
  });

  it("rejects empty recipient_id (system actor)", async () => {
    await expect(
      callHandler(
        sendNotificationAction,
        store.ctx({ recipient_id: "   ", message: "hi" }, { type: "system" }),
      ),
    ).rejects.toThrow(/recipient_id/);
  });

  it("rejects empty message (system actor)", async () => {
    await expect(
      callHandler(
        sendNotificationAction,
        store.ctx({ recipient_id: "user-1", message: "" }, { type: "system" }),
      ),
    ).rejects.toThrow(/message/);
  });

  it("rejects an unsupported channel name (system actor)", async () => {
    await expect(
      callHandler(
        sendNotificationAction,
        store.ctx({ recipient_id: "user-1", message: "hi", channel: "sms" }, { type: "system" }),
      ),
    ).rejects.toThrow(/channel/i);
  });
});

describe("mark_notification_read", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it("sets read_at on an unread notification owned by the actor and emits notification.read", async () => {
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-1", read_at: null });

    const result = (await callHandler(
      markNotificationReadAction,
      store.ctx({ notification_id: "n-1" }, { id: "user-1", type: "human" }),
    )) as Row;

    expect(result.read_at).toBeTypeOf("string");
    expect(store.emitted).toContainEqual(expect.objectContaining({ type: "notification.read" }));
  });

  it("is a no-op on an already-read notification", async () => {
    const existingReadAt = new Date(0).toISOString();
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-1", read_at: existingReadAt });

    const result = (await callHandler(
      markNotificationReadAction,
      store.ctx({ notification_id: "n-1" }, { id: "user-1", type: "human" }),
    )) as Row;

    expect(result.read_at).toBe(existingReadAt);
    expect(store.emitted).toHaveLength(0);
  });

  it("rejects non-owner human callers", async () => {
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-1", read_at: null });
    await expect(
      callHandler(
        markNotificationReadAction,
        store.ctx({ notification_id: "n-1" }, { id: "user-2", type: "human" }),
      ),
    ).rejects.toThrow(/does not belong/i);
  });

  it("lets system actors mark anyone's notification read", async () => {
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-1", read_at: null });
    const result = (await callHandler(
      markNotificationReadAction,
      store.ctx({ notification_id: "n-1" }, { id: "housekeeper", type: "system" }),
    )) as Row;
    expect(result.read_at).toBeTypeOf("string");
  });

  it("rejects empty notification_id", async () => {
    await expect(
      callHandler(
        markNotificationReadAction,
        store.ctx({ notification_id: "" }, { id: "user-1", type: "human" }),
      ),
    ).rejects.toThrow(/notification_id/);
  });
});

describe("mark_all_read", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it("marks every unread notification for the CURRENT actor (input recipient_id ignored for humans)", async () => {
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-1", read_at: null });
    store.rows.set("n-2", { id: "n-2", recipient_id: "user-1", read_at: null });
    store.rows.set("n-3", { id: "n-3", recipient_id: "user-2", read_at: null });
    store.rows.set("n-4", {
      id: "n-4",
      recipient_id: "user-1",
      read_at: "2024-01-01T00:00:00.000Z",
    });

    // Human supplies user-2 as recipient — must be IGNORED. Actor's own queue clears only.
    const result = (await callHandler(
      markAllReadAction,
      store.ctx({ recipient_id: "user-2" }, { id: "user-1", type: "human" }),
    )) as { updated: number; recipient_id: string; hasMore: boolean };

    expect(result).toEqual({ updated: 2, recipient_id: "user-1", hasMore: false });
    expect((store.rows.get("n-1") as Row).read_at).toBeTypeOf("string");
    expect((store.rows.get("n-2") as Row).read_at).toBeTypeOf("string");
    expect((store.rows.get("n-3") as Row).read_at).toBeNull(); // protected
    expect((store.rows.get("n-4") as Row).read_at).toBe("2024-01-01T00:00:00.000Z");
    expect(store.emitted).toContainEqual(
      expect.objectContaining({
        type: "notification.all_read",
        payload: expect.objectContaining({ updated: 2, has_more: false }),
      }),
    );
  });

  it("lets privileged actors operate on an explicit recipient_id", async () => {
    store.rows.set("n-1", { id: "n-1", recipient_id: "user-2", read_at: null });
    store.rows.set("n-2", { id: "n-2", recipient_id: "user-3", read_at: null });

    const result = (await callHandler(
      markAllReadAction,
      store.ctx({ recipient_id: "user-2" }, { id: "housekeeper", type: "system" }),
    )) as { updated: number; recipient_id: string; hasMore: boolean };

    expect(result).toEqual({ updated: 1, recipient_id: "user-2", hasMore: false });
    expect((store.rows.get("n-2") as Row).read_at).toBeNull();
  });

  it("is a no-op when the actor has no unread rows", async () => {
    const result = (await callHandler(
      markAllReadAction,
      store.ctx({}, { id: "ghost", type: "human" }),
    )) as { updated: number };

    expect(result.updated).toBe(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("requires an authenticated actor (empty actor.id rejected)", async () => {
    await expect(
      callHandler(markAllReadAction, store.ctx({}, { id: "", type: "human" })),
    ).rejects.toThrow(/authenticated actor/i);
  });
});
