/**
 * Purchase approval flows
 *
 * Demonstrates Flow + State Machine collaboration in a realistic scenario.
 *
 * Flow 1: purchase_approval — auto-approval routing
 *   Trigger: submit_purchase_request action succeeds (draft → pending)
 *   Logic:
 *     - Amount <= MANAGER_APPROVAL_THRESHOLD: auto-approve immediately
 *     - Amount  > MANAGER_APPROVAL_THRESHOLD: flag for manual manager approval
 *       (the record stays pending)
 *
 *   The amount threshold is NOT hard-coded here — it is imported from the
 *   `manager_approval_threshold` RULE so the policy lives in exactly one place
 *   (the rule's {@link MANAGER_APPROVAL_THRESHOLD}). The flow is a routing
 *   OPTIMISATION; the rule is the AUTHORITY: even if the flow auto-approved a
 *   large request, `approve_purchase_request`'s rule evaluation would block a
 *   non-manager actor. The flow runs as the system/flow-engine actor (not a
 *   manager), so it never auto-approves over the threshold.
 *
 *   NOTE: SyncFlowEngine executes steps sequentially with jump-based branching.
 *   After a condition jump, execution continues from the target step onward.
 *   Steps are ordered so auto_approve comes first (then target), and
 *   flag_for_review is last (else target + natural fall-through end).
 *
 * State machine enforces WHAT transitions are legal.
 * Flows decide WHEN and HOW those transitions happen.
 */

import type { FlowDefinition } from "@linchkit/core";
import { MANAGER_APPROVAL_THRESHOLD } from "../rules/manager-approval-threshold";

/**
 * Main purchase approval orchestration flow.
 *
 * When a purchase request is submitted, this flow runs automatically:
 *   1. Check amount threshold (the rule's single-source-of-truth constant)
 *   2. Low tier (<= threshold) → auto-approve via approve_purchase_request
 *   3. High tier (>  threshold) → flag for manager review, stays pending
 *
 * Step ordering: auto_approve (index 1) → record_routing_note (index 2, last).
 * - Then path: jumps to auto_approve (1), falls through to the note step (2) = end.
 * - Else path: jumps to the note step (2) = end. Record stays pending.
 *
 * Because SyncFlowEngine action steps cannot jump or terminate a branch early
 * (only condition steps branch; an omitted `else` just falls through), BOTH
 * paths execute the final note step. Its text is therefore a PATH-NEUTRAL
 * policy statement — true for an auto-approved record and for one awaiting a
 * manager — never a per-path claim that would be false on the other path.
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
    // Step 0: Route based on amount. The threshold comes from the rule constant,
    // so the flow never encodes a literal that could drift from the rule.
    {
      id: "check_amount",
      type: "condition",
      name: "Auto-Approval Check",
      description: `Amount <= ${MANAGER_APPROVAL_THRESHOLD} can be auto-approved without manager review`,
      expression: `$input.amount <= ${MANAGER_APPROVAL_THRESHOLD}`,
      // biome-ignore lint/suspicious/noThenProperty: flow condition step definition
      then: "auto_approve",
      else: "flag_for_review",
    },

    // Step 1: Auto-approve small requests (then target). The approve action's
    // rule evaluation still runs — it is a no-op here because amount is under
    // the threshold, so the system actor is allowed to approve.
    {
      id: "auto_approve",
      type: "action",
      name: "Auto-Approve Request",
      description: "Immediately approve low-value purchase requests",
      actionName: "approve_purchase_request",
      input: { id: "$input.id" },
    },

    // Step 2: Record the routing policy (else target, also natural end for the
    // then path — see the header comment on why both paths run this step).
    // Calls the real `flag_purchase_for_review` action declared by this
    // capability — no longer the undefined `update_purchase_request`.
    {
      id: "flag_for_review",
      type: "action",
      name: "Record Approval Routing Policy",
      description: "Write an audit note documenting the threshold routing policy applied",
      actionName: "flag_purchase_for_review",
      input: {
        id: "$input.id",
        // PATH-NEUTRAL: this text must stay true on BOTH paths (auto-approved
        // and awaiting-manager) because the engine cannot skip this step on
        // the then path. State the policy, not a per-record outcome.
        audit_notes: `Routed by approval flow: amounts over ${MANAGER_APPROVAL_THRESHOLD} require manual manager approval; amounts at or under the threshold auto-approve.`,
      },
    },
  ],

  onError: "abort",
  timeout: 30000,
};
