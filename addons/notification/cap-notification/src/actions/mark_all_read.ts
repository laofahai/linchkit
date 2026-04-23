/**
 * mark_all_read action
 *
 * Marks every unread notification for the CURRENT actor as read. The recipient
 * is derived from `ctx.actor.id` — callers cannot mass-mark another user's
 * notifications. Privileged actors (system/worker/ai/timer) may pass an
 * explicit `recipient_id` to operate on someone else's queue (used by
 * housekeeping). Idempotent: running with no unread rows is a no-op.
 */

import { defineAction } from "@linchkit/core";

/**
 * Safety cap on how many rows this action touches in a single call. A normal
 * user's unread queue is much smaller than this; the cap exists so a pathological
 * queue (e.g. runaway producer) cannot load unbounded rows into memory. Callers
 * seeing `updated === MARK_ALL_READ_BATCH_SIZE` should re-invoke to finish.
 *
 * TODO(#140 follow-up): once `ctx.query` grows a native `limit`/`offset`, push
 * the cap into the DataProvider instead of slicing post-fetch.
 */
const MARK_ALL_READ_BATCH_SIZE = 1000;

export const markAllReadAction = defineAction({
  name: "mark_all_read",
  entity: "notification",
  label: "Mark All Notifications Read",
  description: "Mark every unread notification for the current actor as read",
  input: {
    recipient_id: {
      type: "string",
      label: "Recipient (privileged only)",
      description: "Optional — only honored when the caller is system/worker/ai/timer",
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
    const isPrivilegedActor =
      actorType === "system" ||
      actorType === "worker" ||
      actorType === "ai" ||
      actorType === "timer";
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

    const allUnread = await ctx.query("notification", {
      recipient_id: recipientId,
      read_at: null,
    });

    if (allUnread.length === 0) {
      return { updated: 0, recipient_id: recipientId, hasMore: false };
    }

    // Cap the batch size so a pathological queue doesn't OOM the action worker.
    const batch = allUnread.slice(0, MARK_ALL_READ_BATCH_SIZE);
    const hasMore = allUnread.length > batch.length;

    const readAt = new Date().toISOString();
    const ids = batch
      .map((row) => (typeof row.id === "string" ? row.id : null))
      .filter((id): id is string => id !== null);

    // Run updates in parallel — each is an independent row write. The underlying
    // DataProvider is expected to either pool connections or serialize as needed.
    await Promise.all(ids.map((id) => ctx.update("notification", id, { read_at: readAt })));

    ctx.emit("notification.all_read", {
      recipient_id: recipientId,
      updated: ids.length,
      has_more: hasMore,
    });

    return { updated: ids.length, recipient_id: recipientId, hasMore };
  },
});
