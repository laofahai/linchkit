/**
 * System schema for execution logs.
 *
 * Backed by the _linchkit_executions table / InMemoryExecutionLogger.
 * Read-only — no CRUD actions, display only.
 */

import { defineSchema, defineView } from "../define";

export const executionLogSchema = defineSchema({
  name: "_execution",
  label: "Execution Log",
  fields: {
    action: { type: "string", required: true, label: "Action" },
    schema: { type: "string", label: "Schema" },
    record_id: { type: "string", label: "Record ID" },
    capability: { type: "string", label: "Capability" },
    actor_id: { type: "string", label: "Actor" },
    actor_type: { type: "string", label: "Actor Type" },
    status: {
      type: "enum",
      options: [
        { value: "succeeded", label: "Succeeded" },
        { value: "failed", label: "Failed" },
        { value: "blocked", label: "Blocked" },
        { value: "pending_approval", label: "Pending Approval" },
      ],
      label: "Status",
    },
    duration: { type: "number", label: "Duration (ms)", ui: { format: "duration" } },
    channel: { type: "string", label: "Channel" },
    error_message: { type: "text", label: "Error" },
    started_at: { type: "datetime", label: "Started At" },
    completed_at: { type: "datetime", label: "Completed At" },
  },
  presentation: {
    titleField: "action",
    badgeField: "status",
    summaryFields: ["action", "status", "duration", "started_at"],
    icon: "activity",
  },
  exposure: { graphql: false, mcp: false },
});

export const executionLogListView = defineView({
  name: "_execution_list",
  schema: "_execution",
  type: "list",
  label: "Execution Logs",
  fields: [
    { field: "started_at", sortable: true, width: 160 },
    { field: "action", sortable: true, filterable: true },
    { field: "schema", filterable: true },
    { field: "actor_id", label: "Actor" },
    { field: "status", sortable: true, filterable: true, width: 140 },
    { field: "duration", sortable: true, width: 120 },
    { field: "channel", width: 100 },
  ],
  defaultSort: { field: "started_at", order: "desc" },
  pageSize: 25,
});
