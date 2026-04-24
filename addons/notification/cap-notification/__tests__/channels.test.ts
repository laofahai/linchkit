/**
 * NotificationChannel unit tests.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  EmailNotificationChannel,
  InAppNotificationChannel,
  type NotificationChannelContext,
  type NotificationDispatchRequest,
  type NotificationStore,
  WebhookNotificationChannel,
} from "../src";

const ctx: NotificationChannelContext = { actorId: "actor-1", tenantId: "t-1" };

class InMemoryStore implements NotificationStore {
  public rows: Array<Record<string, unknown>> = [];
  private seq = 0;
  async create(
    _entity: "notification",
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.seq += 1;
    const row = { id: `n-${this.seq}`, ...data };
    this.rows.push(row);
    return row;
  }
}

function request(
  overrides: Partial<NotificationDispatchRequest> = {},
): NotificationDispatchRequest {
  return {
    recipientId: "user-1",
    message: "hello",
    ...overrides,
  };
}

describe("InAppNotificationChannel", () => {
  let store: InMemoryStore;
  let channel: InAppNotificationChannel;

  beforeEach(() => {
    store = new InMemoryStore();
    channel = new InAppNotificationChannel({ store });
  });

  it("persists a notification row and returns delivered=true with the new id", async () => {
    const result = await channel.send(
      request({ title: "hi", link: "/x", metadata: { a: 1 } }),
      ctx,
    );

    expect(result).toEqual({ channel: "in_app", delivered: true, id: "n-1" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      recipient_id: "user-1",
      channel: "in_app",
      message: "hello",
      title: "hi",
      link: "/x",
      metadata: { a: 1 },
      read_at: null,
    });
  });

  it("returns delivered=false without writing when recipient_id is empty", async () => {
    const result = await channel.send(request({ recipientId: "" }), ctx);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/recipient/i);
    expect(store.rows).toHaveLength(0);
  });

  it("returns delivered=false without writing when message is empty", async () => {
    const result = await channel.send(request({ message: "   " }), ctx);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/message/i);
    expect(store.rows).toHaveLength(0);
  });
});

describe("Stub channels", () => {
  it("email channel returns delivered=false with a reason", async () => {
    const channel = new EmailNotificationChannel();
    const result = await channel.send(request(), ctx);
    expect(result.channel).toBe("email");
    expect(result.delivered).toBe(false);
    expect(result.id).toBeNull();
    expect(result.reason).toMatch(/email/i);
  });

  it("webhook channel returns delivered=false with a reason", async () => {
    const channel = new WebhookNotificationChannel();
    const result = await channel.send(request(), ctx);
    expect(result.channel).toBe("webhook");
    expect(result.delivered).toBe(false);
    expect(result.id).toBeNull();
    expect(result.reason).toMatch(/webhook/i);
  });
});
