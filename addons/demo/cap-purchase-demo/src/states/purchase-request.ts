/**
 * Purchase request state machine definition
 */

import type { StateDefinition } from "@linchkit/core";

export const purchaseRequestState: StateDefinition = {
  name: "purchase_lifecycle",
  entity: "purchase_request",
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
    draft: { label: "t:states.draft", color: "gray" },
    pending: { label: "t:states.pending", color: "yellow" },
    approved: { label: "t:states.approved", color: "green" },
    rejected: { label: "t:states.rejected", color: "red" },
  },
};
