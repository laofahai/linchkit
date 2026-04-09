/**
 * Purchase request event handlers
 *
 * Demonstrates LinchKit's EventHandler system:
 * - State change listeners automatically set timestamps and actor fields
 * - No manual field updates needed in action handlers
 */

import type { EventRecord } from "@linchkit/core";
import { defineEventHandler } from "@linchkit/core";

/**
 * When status changes to "pending" (submitted), auto-set submitted_at timestamp.
 * Listens to record.updated on purchase_request, checks _new._state === "pending"
 */
export const autoSetSubmittedAt = defineEventHandler({
  name: "purchase_auto_submitted_at",
  description: "Auto-set submitted_at when purchase request is submitted",
  listen: "record.updated",
  handler: async (event: EventRecord) => {
    if (event.entity !== "purchase_request") return;

    const newValues = event.payload._new as Record<string, unknown> | undefined;
    if (!newValues || newValues._state !== "pending") return;

    // In a real implementation, this would call an action to set the field.
    // For demo purposes, the logic is shown inline.
    console.log(
      `[purchase-demo] Auto-setting submitted_at for purchase_request (state -> pending)`,
    );
  },
});

/**
 * When status changes to "approved", auto-set approved_at and approved_by.
 * Listens to record.updated on purchase_request, checks _new._state === "approved"
 */
export const autoSetApprovedFields = defineEventHandler({
  name: "purchase_auto_approved_fields",
  description: "Auto-set approved_at and approved_by when purchase request is approved",
  listen: "record.updated",
  handler: async (event: EventRecord) => {
    if (event.entity !== "purchase_request") return;

    const newValues = event.payload._new as Record<string, unknown> | undefined;
    if (!newValues || newValues._state !== "approved") return;

    console.log(
      `[purchase-demo] Auto-setting approved_at and approved_by for purchase_request (state -> approved, actor=${event.actor.id})`,
    );
  },
});

/**
 * Notify when a purchase request is submitted.
 * Listens to record.updated on purchase_request, checks _new._state === "pending"
 */
export const notifyHighPrioritySubmission = defineEventHandler({
  name: "purchase_notify_submission",
  description: "Send notification when a purchase request is submitted",
  listen: "record.updated",
  handler: async (event: EventRecord) => {
    if (event.entity !== "purchase_request") return;

    const newValues = event.payload._new as Record<string, unknown> | undefined;
    if (!newValues || newValues._state !== "pending") return;

    console.log(`[purchase-demo] Notification: Purchase request submitted (state -> pending)`);
  },
});
