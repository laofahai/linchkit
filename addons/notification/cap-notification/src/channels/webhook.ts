/**
 * Webhook notification channel — STUB.
 *
 * TODO(#follow-up): perform signed HTTP POST to a configured target URL
 * with retry + DLQ semantics. Kept as a stub for now.
 */

import type {
  NotificationChannel,
  NotificationChannelContext,
  NotificationDispatchRequest,
  NotificationDispatchResult,
} from "./channel";

export class WebhookNotificationChannel implements NotificationChannel {
  readonly name = "webhook" as const;

  async send(
    _request: NotificationDispatchRequest,
    _context: NotificationChannelContext,
  ): Promise<NotificationDispatchResult> {
    // TODO: implement outbound webhook dispatch; see issue #140 follow-ups.
    return {
      channel: this.name,
      delivered: false,
      id: null,
      reason: "webhook channel not implemented",
    };
  }
}
