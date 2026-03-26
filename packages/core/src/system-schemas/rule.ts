/**
 * System schema for rule definitions.
 *
 * Read-only — backed by the in-memory rule registry.
 * Displays registered business rules for admin inspection.
 */

import { defineSchema, defineView } from "../define";

export const ruleSchema = defineSchema({
  name: "_rule",
  label: "Rule",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    label: { type: "string", label: "Label" },
    description: { type: "text", label: "Description" },
    priority: { type: "number", label: "Priority" },
    trigger_type: {
      type: "enum",
      options: [
        { value: "action", label: "Action" },
        { value: "stateChange", label: "State Change" },
        { value: "fieldChange", label: "Field Change" },
        { value: "event", label: "Event" },
        { value: "schedule", label: "Schedule" },
      ],
      label: "Trigger Type",
    },
    trigger_target: { type: "string", label: "Trigger Target" },
    condition_type: {
      type: "enum",
      options: [
        { value: "declarative", label: "Declarative" },
        { value: "code", label: "Code" },
      ],
      label: "Condition Type",
    },
    effect_type: {
      type: "enum",
      options: [
        { value: "block", label: "Block" },
        { value: "warn", label: "Warn" },
        { value: "require_approval", label: "Require Approval" },
        { value: "enrich", label: "Enrich" },
        { value: "execute_action", label: "Execute Action" },
      ],
      label: "Effect Type",
    },
    effect_message: { type: "text", label: "Effect Message" },
  },
  presentation: {
    titleField: "label",
    subtitleField: "description",
    badgeField: "effect_type",
    summaryFields: ["name", "trigger_type", "effect_type", "priority"],
    icon: "scale",
  },
  exposure: { graphql: false, mcp: false },
});

export const ruleListView = defineView({
  name: "_rule_list",
  schema: "_rule",
  type: "list",
  label: "Rules",
  fields: [
    { field: "name", sortable: true },
    { field: "label" },
    { field: "trigger_type", filterable: true, width: 140 },
    { field: "trigger_target" },
    { field: "condition_type", width: 120 },
    { field: "effect_type", filterable: true, width: 140 },
    { field: "priority", sortable: true, width: 90 },
  ],
  defaultSort: { field: "priority", order: "desc" },
  pageSize: 25,
});
