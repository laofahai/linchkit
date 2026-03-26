/**
 * System schema for state machine definitions.
 *
 * Read-only — backed by registered StateDefinitions.
 * Displays state machine configurations for admin inspection.
 */

import { defineSchema, defineView } from "../define";

export const stateMachineSchema = defineSchema({
  name: "_state_machine",
  label: "State Machine",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    schema: { type: "string", required: true, label: "Schema" },
    field: { type: "string", label: "State Field" },
    initial: { type: "string", label: "Initial State" },
    states_list: { type: "string", label: "States" },
    transitions_count: { type: "number", label: "Transitions" },
  },
  presentation: {
    titleField: "name",
    subtitleField: "schema",
    summaryFields: ["name", "schema", "initial", "transitions_count"],
    icon: "workflow",
  },
  exposure: { graphql: false, mcp: false },
});

export const stateMachineListView = defineView({
  name: "_state_machine_list",
  schema: "_state_machine",
  type: "list",
  label: "State Machines",
  fields: [
    { field: "name", sortable: true },
    { field: "schema", sortable: true, filterable: true },
    { field: "field", label: "State Field" },
    { field: "initial", label: "Initial State", width: 120 },
    { field: "states_list", label: "States" },
    { field: "transitions_count", label: "Transitions", width: 110 },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 25,
});
