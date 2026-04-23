/**
 * mark_all_read action
 *
 * Marks every unread notification owned by the given recipient as read.
 * Idempotent: running against a recipient with no unread rows is a no-op.
 */

import { defineAction } from "@linchkit/core";

export const markAllReadAction = defineAction({
  name: "mark_all_read",
  entity: "notification",
  label: "Mark All Notifications Read",
  description: "Mark every unread notification for the given recipient as read",
  input: {
    recipient_id: {
      type: "string",
      label: "Recipient",
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
    const recipientId = ctx.input.recipient_id;
    if (typeof recipientId !== "string" || !recipientId.trim()) {
      throw new Error("recipient_id is required");
    }

    const unread = await ctx.query("notification", {
      recipient_id: recipientId,
      read_at: null,
    });

    if (unread.length === 0) {
      return { updated: 0, recipient_id: recipientId };
    }

    const readAt = new Date().toISOString();
    let updated = 0;
    for (const row of unread) {
      const id = typeof row.id === "string" ? row.id : null;
      if (!id) continue;
      await ctx.update("notification", id, { read_at: readAt });
      updated += 1;
    }

    ctx.emit("notification.all_read", {
      recipient_id: recipientId,
      updated,
    });

    return { updated, recipient_id: recipientId };
  },
});
