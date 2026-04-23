/**
 * mark_all_read action
 *
 * Marks every unread notification for the CURRENT actor as read. The recipient
 * is derived from `ctx.actor.id` — callers cannot mass-mark another user's
 * notifications. Privileged actors (system/worker/ai) may pass an explicit
 * `recipient_id` to operate on someone else's queue (used by housekeeping).
 * Idempotent: running with no unread rows is a no-op.
 */

import { defineAction } from "@linchkit/core";

export const markAllReadAction = defineAction({
  name: "mark_all_read",
  entity: "notification",
  label: "Mark All Notifications Read",
  description: "Mark every unread notification for the current actor as read",
  input: {
    recipient_id: {
      type: "string",
      label: "Recipient (privileged only)",
      description: "Optional — only honored when the caller is system/worker/ai",
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: true,
  },
  exposure: { http: true, ui: true, cli: true, mcp: true },
  async handler(ctx) {
    const actorType = ctx.actor.type;
    const isPrivilegedActor = actorType === "system" || actorType === "worker" || actorType === "ai";
    const explicitRecipient = ctx.input.recipient_id;

    let recipientId: string;
    if (isPrivilegedActor && typeof explicitRecipient === "string" && explicitRecipient.trim()) {
      recipientId = explicitRecipient.trim();
    } else {
      // Anyone else is locked to their own queue; explicit recipient_id is ignored.
      if (!ctx.actor.id) {
        throw new Error("An authenticated actor is required");
      }
      recipientId = ctx.actor.id;
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
