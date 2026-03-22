/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Loads linchkit.config.ts, then starts the LinchKit server
 * with demo schemas, actions, and seed data.
 * Demonstrates end-to-end: Schema → Action → GraphQL → REST
 */

import type { ActionDefinition, SchemaDefinition, ViewDefinition } from "@linchkit/core";
import { loadConfig } from "./config-loader";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createRuntimeContext } from "./runtime-context";
import { createServer } from "./server";

// ── Load configuration ──────────────────────────────────

const config = await loadConfig();

// ── Demo schema ──────────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request submitted for approval",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", label: "Department" },
    requester: { type: "string", label: "Requester" },
    status: { type: "state", machine: "purchase_lifecycle", default: "draft" },
    priority: {
      type: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ],
      label: "Priority",
    },
    notes: { type: "text", label: "Notes" },
  },
};

const demoSchemas: SchemaDefinition[] = [purchaseRequestSchema];

// ── Demo views ────────────────────────────────────────

const purchaseRequestListView: ViewDefinition = {
  name: "purchase_request_list",
  schema: "purchase_request",
  type: "list",
  label: "Purchase Requests",
  fields: [
    { field: "title", sortable: true },
    { field: "amount", sortable: true, width: 120 },
    { field: "department", sortable: true },
    { field: "priority", sortable: true, width: 100 },
    { field: "status", sortable: true, width: 120 },
  ],
  defaultSort: { field: "title", order: "asc" },
  pageSize: 10,
  actions: [
    { action: "create", label: "New Request", position: "toolbar", variant: "default" },
    { action: "edit", label: "Edit", position: "row" },
    {
      action: "delete",
      label: "Delete",
      position: "row",
      variant: "destructive",
      confirm: "Are you sure you want to delete this request?",
    },
  ],
};

const purchaseRequestFormView: ViewDefinition & { stateActions?: Record<string, string[]> } = {
  name: "purchase_request_form",
  schema: "purchase_request",
  type: "form",
  label: "Purchase Request",
  fields: [
    { field: "title" },
    { field: "amount" },
    { field: "department" },
    { field: "priority" },
    { field: "status", readonly: true },
    { field: "description" },
    { field: "notes" },
    { field: "requester" },
  ],
  layout: {
    nodes: [
      {
        type: "group",
        children: [
          {
            type: "group",
            children: [
              { type: "field", field: "title" },
              { type: "field", field: "department" },
              { type: "field", field: "amount" },
            ],
          },
          {
            type: "group",
            children: [
              { type: "field", field: "priority" },
              { type: "field", field: "requester" },
            ],
          },
        ],
      },
      {
        type: "notebook",
        children: [
          {
            type: "page",
            title: "Details",
            children: [
              {
                type: "group",
                columns: 1,
                children: [{ type: "field", field: "description", nolabel: true }],
              },
            ],
          },
          {
            type: "page",
            title: "Notes",
            children: [
              {
                type: "group",
                columns: 1,
                children: [{ type: "field", field: "notes", nolabel: true }],
              },
            ],
          },
        ],
      },
    ],
  },
  actions: [
    {
      action: "submit_purchase_request",
      label: "Submit for Approval",
      position: "form-header",
      variant: "default",
    },
    {
      action: "approve_purchase_request",
      label: "Approve",
      position: "form-header",
      variant: "default",
    },
  ],
  stateActions: {
    draft: ["submit_purchase_request"],
    pending: ["approve_purchase_request"],
    approved: [],
    rejected: ["submit_purchase_request"],
  },
};

const demoViews: ViewDefinition[] = [purchaseRequestListView, purchaseRequestFormView];

// ── Custom actions (beyond CRUD) ────────────────────────

const submitAction: ActionDefinition = {
  name: "submit_purchase_request",
  schema: "purchase_request",
  label: "Submit Purchase Request",
  description: "Submit a draft purchase request for approval",
  input: {
    notes: { type: "text", label: "Submission Notes" },
  },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "draft") {
      throw new Error(`Cannot submit: current status is "${record.status}", expected "draft"`);
    }
    return ctx.update("purchase_request", id, {
      status: "pending",
      submitted_at: new Date().toISOString(),
    });
  },
};

const approveAction: ActionDefinition = {
  name: "approve_purchase_request",
  schema: "purchase_request",
  label: "Approve Purchase Request",
  description: "Approve a pending purchase request",
  permissions: { groups: ["admin", "manager"] },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "pending") {
      throw new Error(`Cannot approve: current status is "${record.status}", expected "pending"`);
    }
    return ctx.update("purchase_request", id, {
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: ctx.actor.id,
    });
  },
};

// ── Build CRUD + custom actions ─────────────────────────

const allActions: ActionDefinition[] = [
  ...demoSchemas.flatMap(generateCrudActions),
  submitAction,
  approveAction,
];

// ── Initialize runtime context ──────────────────────────

const runtime = createRuntimeContext({
  schemas: demoSchemas,
  actions: allActions,
  views: demoViews,
  ai: config.ai,
});

// Seed demo data
runtime.store.seed("purchase_request", [
  {
    id: "pr_001",
    title: "Office Supplies Q2",
    description: "Quarterly office supply order for engineering team",
    amount: 1500,
    department: "Engineering",
    requester: "Alice Chen",
    status: "draft",
    priority: "medium",
    notes: "Includes monitors and keyboards",
  },
  {
    id: "pr_002",
    title: "Cloud Infrastructure Upgrade",
    description: "AWS reserved instances for production workloads",
    amount: 25000,
    department: "DevOps",
    requester: "Bob Wang",
    status: "pending",
    priority: "high",
    notes: "Annual commitment for cost savings",
  },
  {
    id: "pr_003",
    title: "Team Building Event",
    description: "Annual team outing and dinner",
    amount: 3000,
    department: "HR",
    requester: "Carol Li",
    status: "approved",
    priority: "low",
    notes: null,
  },
  {
    id: "pr_004",
    title: "Security Audit Tools",
    description: "License for penetration testing and vulnerability scanning",
    amount: 8500,
    department: "Security",
    requester: "Dave Zhang",
    status: "draft",
    priority: "urgent",
    notes: "Compliance requirement — deadline next month",
  },
]);

// ── Build schema and start server ────────────────────────

const customActions: ActionDefinition[] = [submitAction, approveAction];

const graphqlSchema = buildGraphQLSchema(demoSchemas, {
  executor: runtime.executor,
  store: runtime.store,
  actions: customActions,
  executionLogger: runtime.executionLogger,
});

const port = config.server?.port ?? 3001;
const host = config.server?.host ?? "0.0.0.0";

const server = createServer(graphqlSchema, {
  port,
  host,
  executor: runtime.executor,
  executionLogger: runtime.executionLogger,
  schemaRegistry: runtime.schemaRegistry,
  views: runtime.views,
});

server.listen(port);

// ── Startup summary ──────────────────────────────────────

const aiSummary = config.ai
  ? `${config.ai.defaultProvider} (${Object.keys(config.ai.providers).join(", ")})`
  : "not configured";

console.log(`\nLinchKit Dev Server`);
console.log(`───────────────────────────────────`);
console.log(`  HTTP:       http://${host}:${port}`);
console.log(`  GraphQL:    http://${host}:${port}/graphql`);
console.log(`  Health:     http://${host}:${port}/health`);
console.log(`  REST API:   http://${host}:${port}/api/actions/:name`);
console.log(`  Exec Logs:  http://${host}:${port}/api/executions`);
console.log(`───────────────────────────────────`);
console.log(`  Schemas:    ${demoSchemas.length} (${demoSchemas.map((s) => s.name).join(", ")})`);
console.log(`  Actions:    ${allActions.length} (${allActions.map((a) => a.name).join(", ")})`);
console.log(`  Records:    ${runtime.store.count("purchase_request")} seed records`);
console.log(`  AI:         ${aiSummary}`);
console.log(`  Logger:     InMemoryExecutionLogger enabled`);
console.log(`───────────────────────────────────\n`);
