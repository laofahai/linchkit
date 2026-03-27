/**
 * System schema definitions for internal entities.
 *
 * These schemas describe system-managed entities (execution logs, approvals,
 * rules, flows, state machines, proposals) so they can be rendered through
 * the standard schema/view/extension UI mechanism.
 *
 * All system schemas are registered via `schemaRegistry.registerInternal()`,
 * making them read-only in the UI. Data comes from system tables or
 * in-memory registries via SystemDataProvider.
 */

import type { SchemaDefinition, ViewDefinition } from "@linchkit/core";

/** Shorthand to build enum options from plain string values */
const opts = (...values: string[]) => values.map((value) => ({ value }));

// ── Execution Log ─────────────────────────────────────────

export const executionLogSchema: SchemaDefinition = {
  name: "execution_log",
  label: "Execution Logs",
  description: "Action execution history with status, duration, and audit trail",
  presentation: {
    titleField: "action_name",
    summaryFields: ["status", "duration_ms", "started_at"],
    icon: "activity",
  },
  fields: {
    action_name: {
      type: "string",
      required: true,
      label: "Action",
    },
    schema_name: {
      type: "string",
      label: "Schema",
    },
    record_id: {
      type: "string",
      label: "Record ID",
    },
    capability: {
      type: "string",
      label: "Capability",
    },
    actor_id: {
      type: "string",
      label: "Actor",
    },
    actor_type: {
      type: "string",
      label: "Actor Type",
    },
    status: {
      type: "enum",
      required: true,
      label: "Status",
      options: opts("succeeded", "failed", "blocked", "pending_approval"),
    },
    duration_ms: {
      type: "number",
      label: "Duration (ms)",
    },
    error_code: {
      type: "string",
      label: "Error Code",
    },
    error_message: {
      type: "text",
      label: "Error Message",
    },
    channel: {
      type: "string",
      label: "Channel",
    },
    input: {
      type: "json",
      label: "Input",
    },
    output: {
      type: "json",
      label: "Output",
    },
    started_at: {
      type: "datetime",
      required: true,
      label: "Started At",
    },
    completed_at: {
      type: "datetime",
      label: "Completed At",
    },
  },
};

export const executionLogListView: ViewDefinition = {
  name: "execution_log_list",
  schema: "execution_log",
  type: "list",
  label: "Execution Logs",
  fields: [
    { field: "started_at", sortable: true, width: 160 },
    { field: "action_name", sortable: true },
    { field: "schema_name", sortable: true },
    { field: "actor_id", sortable: true },
    { field: "status", sortable: true, filterable: true, width: 140 },
    { field: "duration_ms", sortable: true, width: 120 },
  ],
  defaultSort: { field: "started_at", order: "desc" },
  pageSize: 20,
};

// ── Approval ──────────────────────────────────────────────

export const approvalSchema: SchemaDefinition = {
  name: "approval",
  label: "Approvals",
  description: "Approval requests requiring human decision",
  presentation: {
    titleField: "action_name",
    summaryFields: ["status", "level", "reason"],
    icon: "shield-check",
  },
  fields: {
    action_name: {
      type: "string",
      required: true,
      label: "Action",
    },
    schema_name: {
      type: "string",
      label: "Schema",
    },
    record_id: {
      type: "string",
      label: "Record ID",
    },
    capability: {
      type: "string",
      label: "Capability",
    },
    level: {
      type: "string",
      required: true,
      label: "Level",
    },
    reason: {
      type: "text",
      required: true,
      label: "Reason",
    },
    actor_id: {
      type: "string",
      label: "Requester",
    },
    actor_type: {
      type: "string",
      label: "Requester Type",
    },
    assignee_type: {
      type: "enum",
      required: true,
      label: "Assignee Type",
      options: opts("role", "group", "user"),
    },
    assignee_value: {
      type: "string",
      required: true,
      label: "Assignee",
    },
    status: {
      type: "enum",
      required: true,
      label: "Status",
      options: opts("pending", "approved", "rejected", "expired", "cancelled"),
    },
    decided_by: {
      type: "string",
      label: "Decided By",
    },
    decided_at: {
      type: "datetime",
      label: "Decided At",
    },
    decision_note: {
      type: "text",
      label: "Decision Note",
    },
    expires_at: {
      type: "datetime",
      label: "Expires At",
    },
    timeout_policy: {
      type: "string",
      required: true,
      label: "Timeout Policy",
    },
    input: {
      type: "json",
      label: "Input Data",
    },
  },
};

export const approvalListView: ViewDefinition = {
  name: "approval_list",
  schema: "approval",
  type: "list",
  label: "Approvals",
  fields: [
    { field: "created_at", sortable: true, width: 160 },
    { field: "action_name", sortable: true },
    { field: "schema_name", sortable: true },
    { field: "actor_id", sortable: true, label: "Requester" },
    { field: "level", sortable: true, width: 100 },
    { field: "reason" },
    { field: "status", sortable: true, filterable: true, width: 130 },
  ],
  defaultSort: { field: "created_at", order: "desc" },
  pageSize: 20,
};

// ── Rule ──────────────────────────────────────────────────

export const ruleSchema: SchemaDefinition = {
  name: "rule",
  label: "Rules",
  description: "Business rules that validate, guard, or enrich actions",
  presentation: {
    titleField: "name",
    summaryFields: ["label", "priority"],
    icon: "scale",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "Name",
      ui: { importance: "primary" },
    },
    label: {
      type: "string",
      required: true,
      label: "Label",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      label: "Description",
    },
    priority: {
      type: "number",
      required: true,
      label: "Priority",
    },
    trigger: {
      type: "json",
      required: true,
      label: "Trigger",
    },
    condition: {
      type: "json",
      required: true,
      label: "Condition",
    },
    effect_type: {
      type: "enum",
      required: true,
      label: "Effect Type",
      options: opts("block", "warn", "require_approval", "enrich", "execute_action"),
    },
    effect: {
      type: "json",
      required: true,
      label: "Effect",
    },
  },
};

export const ruleListView: ViewDefinition = {
  name: "rule_list",
  schema: "rule",
  type: "list",
  label: "Rules",
  fields: [
    { field: "name", sortable: true },
    { field: "label", sortable: true },
    { field: "priority", sortable: true, width: 100 },
    { field: "effect_type", sortable: true, filterable: true, width: 160 },
    { field: "description" },
  ],
  defaultSort: { field: "priority", order: "asc" },
  pageSize: 20,
  rowActionRoute: "/admin/rules/{id}",
};

// ── Flow ──────────────────────────────────────────────────

export const flowSchema: SchemaDefinition = {
  name: "flow",
  label: "Flows",
  description: "Workflow definitions with steps and triggers",
  presentation: {
    titleField: "name",
    summaryFields: ["label", "trigger_type", "step_count"],
    icon: "workflow",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "Name",
      ui: { importance: "primary" },
    },
    label: {
      type: "string",
      label: "Label",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      label: "Description",
    },
    version: {
      type: "number",
      label: "Version",
    },
    trigger_type: {
      type: "enum",
      required: true,
      label: "Trigger Type",
      options: opts("event", "manual", "schedule"),
    },
    step_count: {
      type: "number",
      label: "Steps",
    },
    trigger: {
      type: "json",
      required: true,
      label: "Trigger Config",
    },
    steps: {
      type: "json",
      label: "Steps",
    },
  },
};

export const flowListView: ViewDefinition = {
  name: "flow_list",
  schema: "flow",
  type: "list",
  label: "Flows",
  fields: [
    { field: "name", sortable: true },
    { field: "label", sortable: true },
    { field: "trigger_type", sortable: true, filterable: true, width: 130 },
    { field: "step_count", sortable: true, width: 80, label: "Steps" },
    { field: "description" },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 20,
  rowActionRoute: "/admin/flows/{id}",
};

// ── State Machine ─────────────────────────────────────────

export const stateMachineSchema: SchemaDefinition = {
  name: "state_machine",
  label: "State Machines",
  description: "State machine definitions with states and transitions",
  presentation: {
    titleField: "name",
    summaryFields: ["schema_name", "field", "state_count"],
    icon: "git-branch",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "Name",
      ui: { importance: "primary" },
    },
    schema_name: {
      type: "string",
      required: true,
      label: "Schema",
      ui: { importance: "primary" },
    },
    field: {
      type: "string",
      required: true,
      label: "Field",
    },
    initial: {
      type: "string",
      required: true,
      label: "Initial State",
    },
    state_count: {
      type: "number",
      label: "States",
    },
    transition_count: {
      type: "number",
      label: "Transitions",
    },
    states: {
      type: "json",
      label: "States",
    },
    meta: {
      type: "json",
      label: "State Metadata",
    },
  },
};

export const stateMachineListView: ViewDefinition = {
  name: "state_machine_list",
  schema: "state_machine",
  type: "list",
  label: "State Machines",
  fields: [
    { field: "name", sortable: true },
    { field: "schema_name", sortable: true, filterable: true },
    { field: "field", sortable: true },
    { field: "initial", sortable: true, width: 120 },
    { field: "state_count", sortable: true, width: 80, label: "States" },
    { field: "transition_count", sortable: true, width: 100, label: "Transitions" },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 20,
  rowActionRoute: "/admin/states/{id}",
};

// ── Proposal ──────────────────────────────────────────────

export const proposalSchema: SchemaDefinition = {
  name: "proposal",
  label: "Proposals",
  description: "AI evolution proposals for schema and capability changes",
  presentation: {
    titleField: "title",
    summaryFields: ["status", "change_type", "author_name"],
    icon: "lightbulb",
  },
  fields: {
    title: {
      type: "string",
      required: true,
      label: "Title",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      required: true,
      label: "Description",
    },
    author_name: {
      type: "string",
      label: "Author",
    },
    author_type: {
      type: "enum",
      label: "Author Type",
      options: opts("human", "ai"),
    },
    capability: {
      type: "string",
      required: true,
      label: "Capability",
    },
    change_type: {
      type: "enum",
      required: true,
      label: "Change Type",
      options: opts("patch", "minor", "major"),
    },
    status: {
      type: "enum",
      required: true,
      label: "Status",
      options: opts("draft", "pending_review", "validated", "approved", "rejected", "committed", "deployed"),
    },
    changes: {
      type: "json",
      label: "Changes",
    },
    impact: {
      type: "json",
      label: "Impact Analysis",
    },
    validation_result: {
      type: "json",
      label: "Validation Result",
    },
    validated_at: {
      type: "datetime",
      label: "Validated At",
    },
    approved_at: {
      type: "datetime",
      label: "Approved At",
    },
    committed_at: {
      type: "datetime",
      label: "Committed At",
    },
    deployed_at: {
      type: "datetime",
      label: "Deployed At",
    },
    rejection_reason: {
      type: "text",
      label: "Rejection Reason",
    },
  },
};

export const proposalListView: ViewDefinition = {
  name: "proposal_list",
  schema: "proposal",
  type: "list",
  label: "Proposals",
  fields: [
    { field: "created_at", sortable: true, width: 160 },
    { field: "title", sortable: true },
    { field: "author_name", sortable: true, width: 120 },
    { field: "capability", sortable: true },
    { field: "change_type", sortable: true, filterable: true, width: 120 },
    { field: "status", sortable: true, filterable: true, width: 130 },
  ],
  defaultSort: { field: "created_at", order: "desc" },
  pageSize: 20,
};

// ── Whitelist of internal schema names ────────────────────

/** Canonical set of system-managed schema names. Only these can be registered as internal. */
export const INTERNAL_SCHEMA_NAMES = new Set([
  "execution_log",
  "approval",
  "rule",
  "flow",
  "state_machine",
  "proposal",
]);

// ── Aggregated exports ────────────────────────────────────

export const systemSchemas: SchemaDefinition[] = [
  executionLogSchema,
  approvalSchema,
  ruleSchema,
  flowSchema,
  stateMachineSchema,
  proposalSchema,
];

export const systemViews: ViewDefinition[] = [
  executionLogListView,
  approvalListView,
  ruleListView,
  flowListView,
  stateMachineListView,
  proposalListView,
];
