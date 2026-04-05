/**
 * Approve purchase request action (declarative)
 */

import type { ActionDefinition } from "@linchkit/core";

export const approveAction: ActionDefinition = {
  name: "approve_purchase_request",
  entity: "purchase_request",
  label: "t:entities.purchase_request.actions.approve",
  description: "Approve a pending purchase request",
  permissions: { groups: ["admin", "manager"] },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  stateTransition: { from: "pending", to: "approved" },
  setFields: {
    approved_at: "$now",
    approved_by: "$actor.id",
  },
};
