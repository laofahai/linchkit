/**
 * Purchase request reactive automations
 *
 * Demonstrates LinchKit's reactive automation system:
 * - State change triggers automatically set timestamps and actor fields
 * - No manual field updates needed in action handlers
 */

import { defineAutomation } from "@linchkit/core";

/**
 * When status changes to "pending" (submitted), auto-set submitted_at timestamp.
 * Trigger: stateChange on purchase_request, to="pending"
 */
export const autoSetSubmittedAt = defineAutomation({
  name: "purchase_auto_submitted_at",
  description: "Auto-set submitted_at when purchase request is submitted",
  trigger: {
    type: "stateChange",
    schema: "purchase_request",
    to: "pending",
  },
  actions: [
    {
      type: "execute_action",
      action: "builtin:set_field",
      input: {
        schema: "purchase_request",
        field: "submitted_at",
        value: "{{$now}}",
      },
    },
  ],
});

/**
 * When status changes to "approved", auto-set approved_at and approved_by.
 * Trigger: stateChange on purchase_request, to="approved"
 */
export const autoSetApprovedFields = defineAutomation({
  name: "purchase_auto_approved_fields",
  description: "Auto-set approved_at and approved_by when purchase request is approved",
  trigger: {
    type: "stateChange",
    schema: "purchase_request",
    to: "approved",
  },
  actions: [
    {
      type: "execute_action",
      action: "builtin:set_field",
      input: {
        schema: "purchase_request",
        field: "approved_at",
        value: "{{$now}}",
      },
    },
    {
      type: "execute_action",
      action: "builtin:set_field",
      input: {
        schema: "purchase_request",
        field: "approved_by",
        value: "{{$actor.id}}",
      },
    },
  ],
});

/**
 * Notify when a high-priority request is submitted.
 * Trigger: stateChange on purchase_request, to="pending" + filter on priority
 */
export const notifyHighPrioritySubmission = defineAutomation({
  name: "purchase_notify_high_priority",
  description: "Send notification when a high-priority purchase request is submitted",
  trigger: {
    type: "stateChange",
    schema: "purchase_request",
    to: "pending",
  },
  actions: [
    {
      type: "send_notification",
      channel: "webhook",
      message: "High-priority purchase request submitted: {{record.title}} ({{record.amount}})",
    },
  ],
});
