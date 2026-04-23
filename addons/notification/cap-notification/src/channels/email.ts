/**
 * Email notification channel — STUB.
 *
 * TODO(#follow-up): wire to a real mail transport (SMTP / SES / Resend).
 * Kept as a stub so the channel interface has a second concrete reference
 * implementation and callers can wire it in without branching on channel name.
 */

import type {
  NotificationChannel,
  NotificationChannelContext,
  NotificationDispatchRequest,
  NotificationDispatchResult,
} from "./channel";

export class EmailNotificationChannel implements NotificationChannel {
  readonly name = "email" as const;

  async send(
    _request: NotificationDispatchRequest,
    _context: NotificationChannelContext,
  ): Promise<NotificationDispatchResult> {
    // TODO: implement SMTP / provider dispatch; see issue #140 follow-ups.
    return {
      channel: this.name,
      delivered: false,
      id: null,
      reason: "email channel not implemented",
    };
  }
}
