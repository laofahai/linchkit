/**
 * System entity definitions for internal entities.
 *
 * These definitions describe system-managed entities (execution logs, approvals,
 * rules, flows, state machines, proposals) so they can be rendered through
 * the standard entity/view/extension UI mechanism.
 *
 * All system entities are registered via `entityRegistry.registerInternal()`,
 * making them read-only in the UI. Data comes from system tables or
 * in-memory registries via SystemDataProvider.
 */

import type { EntityDefinition, ViewDefinition } from "@linchkit/core";

/** Shorthand to build enum options from plain string values */
const opts = (...values: string[]) => values.map((value) => ({ value }));

// ── Execution Log ─────────────────────────────────────────

export const executionLogSchema: EntityDefinition = {
  name: "execution_log",
  label: "t:entities.execution_log._label",
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
      label: "t:entities.execution_log.fields.action_name",
    },
    entity_name: {
      type: "string",
      label: "t:entities.execution_log.fields.entity_name",
    },
    record_id: {
      type: "string",
      label: "t:entities.execution_log.fields.record_id",
    },
    capability: {
      type: "string",
      label: "t:entities.execution_log.fields.capability",
    },
    actor_id: {
      type: "string",
      label: "t:entities.execution_log.fields.actor_id",
    },
    actor_type: {
      type: "string",
      label: "t:entities.execution_log.fields.actor_type",
    },
    status: {
      type: "enum",
      required: true,
      label: "t:entities.execution_log.fields.status",
      options: opts("succeeded", "failed", "blocked", "pending_approval"),
    },
    duration_ms: {
      type: "number",
      label: "t:entities.execution_log.fields.duration_ms",
    },
    error_code: {
      type: "string",
      label: "t:entities.execution_log.fields.error_code",
    },
    error_message: {
      type: "text",
      label: "t:entities.execution_log.fields.error_message",
    },
    channel: {
      type: "string",
      label: "t:entities.execution_log.fields.channel",
    },
    input: {
      type: "json",
      label: "t:entities.execution_log.fields.input",
    },
    output: {
      type: "json",
      label: "t:entities.execution_log.fields.output",
    },
    meta: {
      type: "json",
      label: "t:entities.execution_log.fields.meta",
    },
    state_transition_from: {
      type: "string",
      label: "t:entities.execution_log.fields.state_transition_from",
    },
    state_transition_to: {
      type: "string",
      label: "t:entities.execution_log.fields.state_transition_to",
    },
    started_at: {
      type: "datetime",
      required: true,
      label: "t:entities.execution_log.fields.started_at",
    },
    completed_at: {
      type: "datetime",
      label: "t:entities.execution_log.fields.completed_at",
    },
  },
};

export const executionLogListView: ViewDefinition = {
  name: "execution_log_list",
  entity: "execution_log",
  type: "list",
  label: "t:entities.execution_log._labelPlural",
  fields: [
    { field: "started_at", sortable: true, width: 160 },
    { field: "action_name", sortable: true },
    { field: "entity_name", sortable: true },
    { field: "actor_id", sortable: true },
    { field: "status", sortable: true, filterable: true, width: 140 },
    { field: "duration_ms", sortable: true, width: 120 },
  ],
  defaultSort: { field: "started_at", order: "desc" },
  pageSize: 20,
};

// ── Approval ──────────────────────────────────────────────

export const approvalSchema: EntityDefinition = {
  name: "approval",
  label: "t:entities.approval._label",
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
      label: "t:entities.approval.fields.action_name",
    },
    entity_name: {
      type: "string",
      label: "t:entities.approval.fields.entity_name",
    },
    record_id: {
      type: "string",
      label: "t:entities.approval.fields.record_id",
    },
    capability: {
      type: "string",
      label: "t:entities.approval.fields.capability",
    },
    level: {
      type: "string",
      required: true,
      label: "t:entities.approval.fields.level",
    },
    reason: {
      type: "text",
      required: true,
      label: "t:entities.approval.fields.reason",
    },
    actor_id: {
      type: "string",
      label: "t:entities.approval.fields.actor_id",
    },
    actor_type: {
      type: "string",
      label: "t:entities.approval.fields.actor_type",
    },
    assignee_type: {
      type: "enum",
      required: true,
      label: "t:entities.approval.fields.assignee_type",
      options: opts("role", "group", "user"),
    },
    assignee_value: {
      type: "string",
      required: true,
      label: "t:entities.approval.fields.assignee_value",
    },
    status: {
      type: "enum",
      required: true,
      label: "t:entities.approval.fields.status",
      options: opts("pending", "approved", "rejected", "expired", "cancelled"),
    },
    decided_by: {
      type: "string",
      label: "t:entities.approval.fields.decided_by",
    },
    decided_at: {
      type: "datetime",
      label: "t:entities.approval.fields.decided_at",
    },
    decision_note: {
      type: "text",
      label: "t:entities.approval.fields.decision_note",
    },
    expires_at: {
      type: "datetime",
      label: "t:entities.approval.fields.expires_at",
    },
    timeout_policy: {
      type: "string",
      required: true,
      label: "t:entities.approval.fields.timeout_policy",
    },
    input: {
      type: "json",
      label: "t:entities.approval.fields.input",
    },
  },
};

export const approvalListView: ViewDefinition = {
  name: "approval_list",
  entity: "approval",
  type: "list",
  label: "t:entities.approval._labelPlural",
  fields: [
    { field: "created_at", sortable: true, width: 160 },
    { field: "action_name", sortable: true },
    { field: "entity_name", sortable: true },
    { field: "actor_id", sortable: true, label: "t:entities.approval.fields.actor_id" },
    { field: "level", sortable: true, width: 100 },
    { field: "reason" },
    { field: "status", sortable: true, filterable: true, width: 130 },
  ],
  defaultSort: { field: "created_at", order: "desc" },
  pageSize: 20,
};

// ── Rule ──────────────────────────────────────────────────

export const ruleSchema: EntityDefinition = {
  name: "rule",
  label: "t:entities.rule._label",
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
      label: "t:entities.rule.fields.name",
      ui: { importance: "primary" },
    },
    label: {
      type: "string",
      required: true,
      label: "t:entities.rule.fields.label",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      label: "t:entities.rule.fields.description",
    },
    priority: {
      type: "number",
      required: true,
      label: "t:entities.rule.fields.priority",
    },
    trigger: {
      type: "json",
      required: true,
      label: "t:entities.rule.fields.trigger",
    },
    condition: {
      type: "json",
      required: true,
      label: "t:entities.rule.fields.condition",
    },
    effect_type: {
      type: "enum",
      required: true,
      label: "t:entities.rule.fields.effect_type",
      options: opts("block", "warn", "require_approval", "enrich", "execute_action"),
    },
    effect: {
      type: "json",
      required: true,
      label: "t:entities.rule.fields.effect",
    },
  },
};

export const ruleListView: ViewDefinition = {
  name: "rule_list",
  entity: "rule",
  type: "list",
  label: "t:entities.rule._labelPlural",
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

export const flowSchema: EntityDefinition = {
  name: "flow",
  label: "t:entities.flow._label",
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
      label: "t:entities.flow.fields.name",
      ui: { importance: "primary" },
    },
    label: {
      type: "string",
      label: "t:entities.flow.fields.label",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      label: "t:entities.flow.fields.description",
    },
    version: {
      type: "number",
      label: "t:entities.flow.fields.version",
    },
    trigger_type: {
      type: "enum",
      required: true,
      label: "t:entities.flow.fields.trigger_type",
      options: opts("event", "manual", "schedule"),
    },
    step_count: {
      type: "number",
      label: "t:entities.flow.fields.step_count",
    },
    trigger: {
      type: "json",
      required: true,
      label: "t:entities.flow.fields.trigger",
    },
    steps: {
      type: "json",
      label: "t:entities.flow.fields.steps",
    },
  },
};

export const flowListView: ViewDefinition = {
  name: "flow_list",
  entity: "flow",
  type: "list",
  label: "t:entities.flow._labelPlural",
  fields: [
    { field: "name", sortable: true },
    { field: "label", sortable: true },
    { field: "trigger_type", sortable: true, filterable: true, width: 130 },
    { field: "step_count", sortable: true, width: 80, label: "t:entities.flow.fields.step_count" },
    { field: "description" },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 20,
  rowActionRoute: "/admin/flows/{id}",
};

// ── State Machine ─────────────────────────────────────────

export const stateMachineSchema: EntityDefinition = {
  name: "state_machine",
  label: "t:entities.state_machine._label",
  description: "State machine definitions with states and transitions",
  presentation: {
    titleField: "name",
    summaryFields: ["entity_name", "field", "state_count"],
    icon: "git-branch",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "t:entities.state_machine.fields.name",
      ui: { importance: "primary" },
    },
    entity_name: {
      type: "string",
      required: true,
      label: "t:entities.state_machine.fields.entity_name",
      ui: { importance: "primary" },
    },
    field: {
      type: "string",
      required: true,
      label: "t:entities.state_machine.fields.field",
    },
    initial: {
      type: "string",
      required: true,
      label: "t:entities.state_machine.fields.initial",
    },
    state_count: {
      type: "number",
      label: "t:entities.state_machine.fields.state_count",
    },
    transition_count: {
      type: "number",
      label: "t:entities.state_machine.fields.transition_count",
    },
    states: {
      type: "json",
      label: "t:entities.state_machine.fields.states",
    },
    meta: {
      type: "json",
      label: "t:entities.state_machine.fields.meta",
    },
  },
};

export const stateMachineListView: ViewDefinition = {
  name: "state_machine_list",
  entity: "state_machine",
  type: "list",
  label: "t:entities.state_machine._labelPlural",
  fields: [
    { field: "name", sortable: true },
    { field: "entity_name", sortable: true, filterable: true },
    { field: "field", sortable: true },
    { field: "initial", sortable: true, width: 120 },
    {
      field: "state_count",
      sortable: true,
      width: 80,
      label: "t:entities.state_machine.fields.state_count",
    },
    {
      field: "transition_count",
      sortable: true,
      width: 100,
      label: "t:entities.state_machine.fields.transition_count",
    },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 20,
  rowActionRoute: "/admin/states/{id}",
};

// ── Proposal ──────────────────────────────────────────────

export const proposalSchema: EntityDefinition = {
  name: "proposal",
  label: "t:entities.proposal._label",
  description: "AI evolution proposals for entity and capability changes",
  presentation: {
    titleField: "title",
    summaryFields: ["status", "change_type", "author_name"],
    icon: "lightbulb",
  },
  fields: {
    title: {
      type: "string",
      required: true,
      label: "t:entities.proposal.fields.title",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      required: true,
      label: "t:entities.proposal.fields.description",
    },
    author_name: {
      type: "string",
      label: "t:entities.proposal.fields.author_name",
    },
    author_type: {
      type: "enum",
      label: "t:entities.proposal.fields.author_type",
      options: opts("human", "ai"),
    },
    capability: {
      type: "string",
      required: true,
      label: "t:entities.proposal.fields.capability",
    },
    change_type: {
      type: "enum",
      required: true,
      label: "t:entities.proposal.fields.change_type",
      options: opts("patch", "minor", "major"),
    },
    status: {
      type: "enum",
      required: true,
      label: "t:entities.proposal.fields.status",
      options: opts(
        "draft",
        "pending_review",
        "validated",
        "approved",
        "rejected",
        "committed",
        "deployed",
      ),
    },
    changes: {
      type: "json",
      label: "t:entities.proposal.fields.changes",
    },
    impact: {
      type: "json",
      label: "t:entities.proposal.fields.impact",
    },
    validation_result: {
      type: "json",
      label: "t:entities.proposal.fields.validation_result",
    },
    validated_at: {
      type: "datetime",
      label: "t:entities.proposal.fields.validated_at",
    },
    approved_at: {
      type: "datetime",
      label: "t:entities.proposal.fields.approved_at",
    },
    committed_at: {
      type: "datetime",
      label: "t:entities.proposal.fields.committed_at",
    },
    deployed_at: {
      type: "datetime",
      label: "t:entities.proposal.fields.deployed_at",
    },
    rejection_reason: {
      type: "text",
      label: "t:entities.proposal.fields.rejection_reason",
    },
  },
};

export const proposalListView: ViewDefinition = {
  name: "proposal_list",
  entity: "proposal",
  type: "list",
  label: "t:entities.proposal._labelPlural",
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

/** Canonical set of system-managed entity names. Only these can be registered as internal. */
export const INTERNAL_SCHEMA_NAMES = new Set([
  "execution_log",
  "approval",
  "rule",
  "flow",
  "state_machine",
  "proposal",
]);

// ── Aggregated exports ────────────────────────────────────

export const systemSchemas: EntityDefinition[] = [
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
