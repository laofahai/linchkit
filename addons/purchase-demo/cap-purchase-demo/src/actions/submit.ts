/**
 * Submit purchase request action (declarative)
 */

import type { ActionDefinition } from "@linchkit/core";

export const submitAction: ActionDefinition = {
  name: "submit_purchase_request",
  schema: "purchase_request",
  label: "t:schemas.purchase_request.actions.submit_for_approval",
  description: "Submit a draft purchase request for approval",
  input: {
    notes: { type: "text", label: "t:schemas.purchase_request.fields.notes" },
  },
  permissions: { groups: ["admin", "manager", "user"] },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  stateTransition: { from: "draft", to: "pending" },
  setFields: {
    submitted_at: "$now",
  },
};
