/**
 * Purchase approval flows
 *
 * Demonstrates Flow + State Machine collaboration in a realistic scenario.
 *
 * Flow 1: purchase_approval — auto-approval for small purchases
 *   Trigger: submit_purchase_request action succeeds (draft → pending)
 *   Logic:
 *     - Amount <= 5000: auto-approve immediately
 *     - Amount > 5000: flag for manual manager approval (stays pending)
 *
 *   NOTE: SyncFlowEngine executes steps sequentially with jump-based branching.
 *   After a condition jump, execution continues from the target step onward.
 *   Steps are ordered so auto_approve comes first (then target), and
 *   flag_for_review is last (else target + natural fall-through end).
 *
 * Flow 2: purchase_rejection_followup — audit trail on rejection
 *   Trigger: reject_purchase_request action succeeds (pending → rejected)
 *
 * State machine enforces WHAT transitions are legal.
 * Flows decide WHEN and HOW those transitions happen.
 */

import type { FlowDefinition } from "@linchkit/core";

/**
 * Main purchase approval orchestration flow.
 *
 * When a purchase request is submitted, this flow runs automatically:
 *   1. Check amount threshold
 *   2. Low tier (<=5000) → auto-approve via approve_purchase_request action
 *   3. High tier (>5000) → flag for manager review, stays pending
 *
 * Step ordering: auto_approve (index 1) → flag_for_review (index 2, last).
 * - Then path: jumps to auto_approve (1), falls through to flag_for_review (2) = end.
 *   The flag step harmlessly adds an audit note to the already-approved record.
 * - Else path: jumps to flag_for_review (2) = end. Record stays pending.
 */
export const purchaseApprovalFlow: FlowDefinition = {
  name: "purchase_approval",
  label: "Purchase Approval Orchestration",
  description:
    "Routes purchase requests through approval tiers based on amount. " +
    "Small requests auto-approve; large requests are flagged for manager.",
  version: 1,

  trigger: {
    type: "event",
    eventType: "action.succeeded",
    filter: { action: "submit_purchase_request" },
  },

  steps: [
    // Step 0: Route based on amount
    {
      id: "check_amount",
      type: "condition",
      name: "Auto-Approval Check",
      description: "Amount <= 5000 can be auto-approved without human review",
      expression: "$input.amount <= 5000",
      // biome-ignore lint/suspicious/noThenProperty: flow condition step definition
      then: "auto_approve",
      else: "flag_for_review",
    },

    // Step 1: Auto-approve small requests (then target)
    {
      id: "auto_approve",
      type: "action",
      name: "Auto-Approve Request",
      description: "Immediately approve low-value purchase requests",
      actionName: "approve_purchase_request",
      input: { id: "$input.id" },
    },

    // Step 2: Flag for manager review (else target, also natural end for then path)
    {
      id: "flag_for_review",
      type: "action",
      name: "Record Approval Decision",
      description: "Write audit trail note recording the approval routing decision",
      actionName: "update_purchase_request",
      input: {
        id: "$input.id",
        audit_notes:
          "Routed by approval flow. Manual manager approval required for amounts over 5,000.",
      },
    },
  ],

  onError: "abort",
  timeout: 30000,
};
