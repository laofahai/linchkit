/**
 * In-app notification channel.
 *
 * Persists notifications to the `notification` entity. The UI layer queries
 * this entity via GraphQL (read-only) to render the notification center;
 * writes always flow through Actions.
 */

import type {
  NotificationChannel,
  NotificationChannelContext,
  NotificationDispatchRequest,
  NotificationDispatchResult,
} from "./channel";

/**
 * Minimal persistence contract the in-app channel needs.
 *
 * Action handlers receive an `ActionContext` whose `create()` matches this
 * shape, so the channel can be driven directly by `ctx.create` without any
 * extra adapter. Tests may provide their own in-memory implementation.
 */
export interface NotificationStore {
  create(entity: "notification", data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface InAppChannelOptions {
  /** Store used to persist the notification record */
  store: NotificationStore;
}

export class InAppNotificationChannel implements NotificationChannel {
  readonly name = "in_app" as const;

  constructor(private readonly options: InAppChannelOptions) {}

  async send(
    request: NotificationDispatchRequest,
    _context: NotificationChannelContext,
  ): Promise<NotificationDispatchResult> {
    if (!request.recipientId?.trim()) {
      return { channel: this.name, delivered: false, id: null, reason: "recipient_id is required" };
    }
    if (!request.message?.trim()) {
      return { channel: this.name, delivered: false, id: null, reason: "message is required" };
    }

    const record = await this.options.store.create("notification", {
      recipient_id: request.recipientId,
      channel: this.name,
      title: request.title,
      message: request.message,
      link: request.link,
      metadata: request.metadata,
      read_at: null,
    });

    const id = typeof record.id === "string" ? record.id : null;

    return { channel: this.name, delivered: true, id };
  }
}

/** Factory helper, mirrors the style used by other cap-* addons. */
export function createInAppChannel(options: InAppChannelOptions): InAppNotificationChannel {
  return new InAppNotificationChannel(options);
}
