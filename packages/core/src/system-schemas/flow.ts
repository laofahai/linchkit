/**
 * System schema for flow definitions.
 *
 * Read-only — backed by FlowRegistry.
 * Displays registered flow definitions for admin inspection.
 */

import { defineSchema, defineView } from "../define";

export const flowSchema = defineSchema({
  name: "_flow",
  label: "Flow",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    label: { type: "string", label: "Label" },
    description: { type: "text", label: "Description" },
    version: { type: "number", label: "Version" },
    trigger_type: {
      type: "enum",
      options: [
        { value: "event", label: "Event" },
        { value: "manual", label: "Manual" },
        { value: "schedule", label: "Schedule" },
      ],
      label: "Trigger Type",
    },
    trigger_detail: { type: "string", label: "Trigger Detail" },
    steps_count: { type: "number", label: "Steps" },
    on_error: {
      type: "enum",
      options: [
        { value: "abort", label: "Abort" },
        { value: "retry", label: "Retry" },
        { value: "compensate", label: "Compensate" },
      ],
      label: "On Error",
    },
  },
  presentation: {
    titleField: "label",
    subtitleField: "description",
    badgeField: "trigger_type",
    summaryFields: ["name", "trigger_type", "steps_count", "version"],
    icon: "git-branch",
  },
  exposure: { graphql: false, mcp: false },
});

export const flowListView = defineView({
  name: "_flow_list",
  schema: "_flow",
  type: "list",
  label: "Flows",
  fields: [
    { field: "name", sortable: true },
    { field: "label" },
    { field: "trigger_type", filterable: true, width: 130 },
    { field: "trigger_detail" },
    { field: "steps_count", label: "Steps", width: 80 },
    { field: "version", width: 80 },
    { field: "on_error", width: 120 },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 25,
});
