/**
 * Purchase request state machine definition
 */

import type { StateDefinition } from "@linchkit/core";

export const purchaseRequestState: StateDefinition = {
  name: "purchase_lifecycle",
  schema: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit_purchase_request" },
    { from: "pending", to: "approved", action: "approve_purchase_request" },
    { from: "pending", to: "rejected", action: "reject_purchase_request" },
    { from: "rejected", to: "pending", action: "submit_purchase_request" },
  ],
  meta: {
    draft: { label: "Draft", color: "gray" },
    pending: { label: "Pending", color: "yellow" },
    approved: { label: "Approved", color: "green" },
    rejected: { label: "Rejected", color: "red" },
  },
};
