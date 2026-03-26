/**
 * System schema for approval requests.
 *
 * Read-only — backed by ApprovalStore.
 */

import { defineSchema, defineView } from "../define";

export const approvalSchema = defineSchema({
  name: "_approval",
  label: "Approval",
  fields: {
    action: { type: "string", required: true, label: "Action" },
    schema: { type: "string", label: "Schema" },
    record_id: { type: "string", label: "Record ID" },
    level: { type: "string", label: "Approval Level" },
    reason: { type: "text", label: "Reason" },
    requested_by: { type: "string", label: "Requested By" },
    assignee_type: {
      type: "enum",
      options: [
        { value: "role", label: "Role" },
        { value: "group", label: "Group" },
        { value: "user", label: "User" },
      ],
      label: "Assignee Type",
    },
    assignee_value: { type: "string", label: "Assignee" },
    status: {
      type: "enum",
      options: [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
        { value: "rejected", label: "Rejected" },
        { value: "expired", label: "Expired" },
        { value: "cancelled", label: "Cancelled" },
      ],
      label: "Status",
    },
    decided_by: { type: "string", label: "Decided By" },
    decided_at: { type: "datetime", label: "Decided At" },
    decision_note: { type: "text", label: "Decision Note" },
    expires_at: { type: "datetime", label: "Expires At" },
    timeout_policy: {
      type: "enum",
      options: [
        { value: "reject", label: "Auto-Reject" },
        { value: "escalate", label: "Escalate" },
        { value: "none", label: "None" },
      ],
      label: "Timeout Policy",
    },
  },
  presentation: {
    titleField: "action",
    subtitleField: "reason",
    badgeField: "status",
    summaryFields: ["action", "status", "level", "requested_by"],
    icon: "shield-check",
  },
  exposure: { graphql: false, mcp: false },
});

export const approvalListView = defineView({
  name: "_approval_list",
  schema: "_approval",
  type: "list",
  label: "Approvals",
  fields: [
    { field: "action", sortable: true, filterable: true },
    { field: "schema", filterable: true },
    { field: "level", width: 120 },
    { field: "requested_by" },
    { field: "assignee_value", label: "Assignee" },
    { field: "status", sortable: true, filterable: true, width: 120 },
    { field: "decided_at", sortable: true, width: 160 },
    { field: "expires_at", width: 160 },
  ],
  defaultSort: { field: "status", order: "asc" },
  pageSize: 25,
});
