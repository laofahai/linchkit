/**
 * Reject purchase request action (declarative)
 */

import type { ActionDefinition } from "@linchkit/core";

export const rejectAction: ActionDefinition = {
  name: "reject_purchase_request",
  entity: "purchase_request",
  label: "t:entities.purchase_request.actions.reject",
  description: "Reject a pending purchase request",
  input: {
    reason: { type: "text", label: "Rejection Reason", required: true },
  },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  stateTransition: { from: "pending", to: "rejected" },
  setFields: {
    audit_notes: "$input.reason",
  },
};
