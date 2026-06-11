/**
 * Flag purchase request for manager review action (declarative).
 *
 * Records the approval-routing decision as an audit note WITHOUT changing the
 * request's state — the record stays in `pending` so a manager can act on it.
 *
 * This is the real, registered action the approval flow's `flag_for_review`
 * step calls. Previously the flow called an undefined `update_purchase_request`
 * action that only existed as an auto-generated CRUD action at server-assembly
 * time (and so crashed any capability-level / standalone flow run). Defining it
 * here makes the capability self-contained and honest: the flow depends only on
 * actions the capability itself declares.
 */

import type { ActionDefinition } from "@linchkit/core";

export const flagForReviewAction: ActionDefinition = {
  name: "flag_purchase_for_review",
  entity: "purchase_request",
  label: "t:entities.purchase_request.actions.flag_for_review",
  description: "Record an audit note routing a purchase request to manual manager review",
  input: {
    audit_notes: {
      type: "text",
      label: "t:entities.purchase_request.fields.audit_notes",
      required: true,
    },
  },
  policy: { mode: "sync", transaction: true },
  // Internal-only: this is a flow-step helper, not a user-facing operation.
  // Publishing it to HTTP/GraphQL/MCP would let any external caller overwrite
  // `audit_notes` on a request in any status, undermining the audit trail it
  // exists to record (codex P2 on the scenario-P1 review). Unset exposure keys
  // default to ALLOWED (`isExposed` checks `!== false`), so every external
  // channel must be switched off explicitly; the flow engine executes with the
  // default "internal" channel and passes.
  exposure: { http: false, mcp: false, cli: false, ui: false, internal: true },
  // No stateTransition: the request stays `pending`. The declarative write path
  // fires because `setFields` is present (action-engine Step 4c/7).
  setFields: {
    audit_notes: "$input.audit_notes",
  },
};
