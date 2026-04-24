/**
 * mark_notification_read action
 *
 * Sets `read_at` on a single notification record owned by the calling actor.
 * Idempotent: re-running on an already-read notification is a no-op that
 * returns the existing record unchanged.
 */

import { defineAction } from "@linchkit/core";

export const markNotificationReadAction = defineAction({
  name: "mark_notification_read",
  entity: "notification",
  label: "Mark Notification Read",
  description: "Mark a single notification as read for the current recipient",
  input: {
    notification_id: {
      type: "string",
      label: "Notification ID",
      required: true,
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: true,
  },
  exposure: { http: true, ui: true, cli: true, mcp: true },
  async handler(ctx) {
    const notificationId = ctx.input.notification_id;
    if (typeof notificationId !== "string" || !notificationId.trim()) {
      throw new Error("notification_id is required");
    }

    const record = await ctx.get("notification", notificationId);

    // Ownership guard — a notification may only be marked read by its recipient.
    // System/worker/ai/timer actors are allowed to mark any record (used by
    // housekeeping flows); human actors must match record.recipient_id.
    const actorType = ctx.actor.type;
    const isPrivilegedActor =
      actorType === "system" ||
      actorType === "worker" ||
      actorType === "ai" ||
      actorType === "timer";
    if (!isPrivilegedActor && record.recipient_id !== ctx.actor.id) {
      throw new Error("Notification does not belong to the current actor");
    }

    // Already read — return current record without a pointless write.
    if (record.read_at != null) {
      return record;
    }

    const updated = await ctx.update("notification", notificationId, {
      read_at: new Date().toISOString(),
    });

    ctx.emit("notification.read", {
      notification_id: notificationId,
      recipient_id: record.recipient_id,
    });

    return updated;
  },
});
