/**
 * Demo schema, view definitions, and sample data for the purchase_request entity.
 * Used by schema-list and schema-form demo pages.
 */

import type { SchemaDefinition, StateDefinition, ViewDefinition } from "@linchkit/core";
import type { AutoListViewDefinition } from "../components/auto-list";

export const demoSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title", min: 2, max: 100 },
    amount: {
      type: "number",
      required: true,
      label: "Amount",
      min: 0,
      ui: { importance: "primary", format: "currency", width: 4 },
    },
    department: { type: "string", label: "Department" },
    status: { type: "state", machine: "pr_lifecycle", label: "Status" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
    description: { type: "text", label: "Description", description: "Provide a detailed description of the purchase request." },
    requested_at: { type: "datetime", label: "Requested At" },
    approved: { type: "boolean", label: "Approved" },
  },
  presentation: {
    titleField: "title",
    badgeField: "status",
    summaryFields: ["amount", "department", "priority"],
    icon: "ShoppingCart",
  },
};

/** Single source of truth for purchase request state colors + labels */
export const demoStateMachine: StateDefinition = {
  name: "pr_lifecycle",
  schema: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit_for_approval" },
    { from: "draft", to: "draft", action: "cancel" },
    { from: "pending", to: "approved", action: "approve" },
    { from: "pending", to: "rejected", action: "reject" },
    { from: "rejected", to: "pending", action: "submit_for_approval" },
  ],
  meta: {
    draft: { label: "Draft", color: "secondary" },
    pending: { label: "Pending", color: "warning" },
    approved: { label: "Approved", color: "success" },
    rejected: { label: "Rejected", color: "danger" },
  },
};

export const demoListView: AutoListViewDefinition = {
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
    { field: "requested_at", sortable: true, label: "Requested", width: 180 },
    { field: "approved", width: 80 },
  ],
  filters: [
    { field: "title", type: "text", placeholder: "Search by title..." },
    { field: "status", type: "select", label: "Status", options: [
      { value: "draft", label: "Draft" },
      { value: "pending", label: "Pending" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" },
    ]},
    { field: "priority", type: "select", label: "Priority" },
    { field: "department", type: "select", label: "Department", options: [
      { value: "Operations", label: "Operations" },
      { value: "Engineering", label: "Engineering" },
      { value: "Marketing", label: "Marketing" },
      { value: "HR", label: "HR" },
    ]},
  ],
  defaultSort: { field: "requested_at", order: "desc" },
  pageSize: 5,
  actions: [
    { action: "create", label: "New Request", position: "toolbar", variant: "default" },
    { action: "edit", label: "Edit", position: "row" },
    { action: "delete", label: "Delete", position: "row", variant: "destructive", confirm: "Are you sure you want to delete this request?" },
  ],
};

export const demoFormView: ViewDefinition & { stateActions?: Record<string, string[]> } = {
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
    { field: "requested_at" },
    { field: "approved" },
  ],
  layout: {
    // Odoo-style group nesting
    nodes: [
      // Top-level 2-column group
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
              { type: "field", field: "requested_at" },
              { type: "field", field: "approved" },
            ],
          },
        ],
      },
      // Notebook with tabs
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
                children: [
                  { type: "field", field: "description", nolabel: true },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  actions: [
    { action: "submit_for_approval", label: "Submit for Approval", position: "form-header", variant: "default" },
    { action: "approve", label: "Approve", position: "form-header", variant: "default" },
    { action: "reject", label: "Reject", position: "form-header", variant: "destructive" },
    { action: "cancel", label: "Cancel Request", position: "form-header", variant: "ghost" },
  ],
  // State-driven action mapping: status -> available action names
  stateActions: {
    draft: ["submit_for_approval", "cancel"],
    pending: ["approve", "reject"],
    approved: [],
    rejected: ["submit_for_approval"],
  },
};

export const demoData: Record<string, unknown>[] = [
  {
    id: "pr-001",
    title: "Office Supplies Q1",
    amount: 2500,
    department: "Operations",
    status: "approved",
    priority: "low",
    description: "Quarterly office supply restock including paper, pens, and printer toner.",
    requested_at: "2026-01-15T09:30:00Z",
    approved: true,
  },
  {
    id: "pr-002",
    title: "Server Hardware Upgrade",
    amount: 45000,
    department: "Engineering",
    status: "pending",
    priority: "high",
    description: "Upgrade production servers with new CPUs and additional RAM.",
    requested_at: "2026-02-20T14:15:00Z",
    approved: false,
  },
  {
    id: "pr-003",
    title: "Marketing Campaign Materials",
    amount: 12000,
    department: "Marketing",
    status: "draft",
    priority: "medium",
    description: "Print and digital materials for the spring product launch.",
    requested_at: "2026-03-01T10:00:00Z",
    approved: false,
  },
  {
    id: "pr-004",
    title: "Employee Training Program",
    amount: 8500,
    department: "HR",
    status: "approved",
    priority: "medium",
    description: "Annual compliance and skills training for all employees.",
    requested_at: "2026-03-05T08:45:00Z",
    approved: true,
  },
  {
    id: "pr-005",
    title: "Cloud Infrastructure Expansion",
    amount: 32000,
    department: "Engineering",
    status: "pending",
    priority: "high",
    description: "Expand cloud compute capacity to handle increased traffic.",
    requested_at: "2026-03-10T16:30:00Z",
    approved: false,
  },
  {
    id: "pr-006",
    title: "Ergonomic Desk Chairs",
    amount: 6200,
    department: "Operations",
    status: "rejected",
    priority: "low",
    description: "Replace old desk chairs with ergonomic models for the main office.",
    requested_at: "2026-03-12T11:20:00Z",
    approved: false,
  },
  {
    id: "pr-007",
    title: "Security Audit Services",
    amount: 18000,
    department: "Engineering",
    status: "approved",
    priority: "high",
    description: "Annual third-party security audit and penetration testing.",
    requested_at: "2026-03-15T09:00:00Z",
    approved: true,
  },
  {
    id: "pr-008",
    title: "Conference Room AV Equipment",
    amount: 15500,
    department: "Operations",
    status: "pending",
    priority: "medium",
    description: "Upgrade AV equipment in main conference rooms for hybrid meetings.",
    requested_at: "2026-03-16T13:00:00Z",
    approved: false,
  },
  {
    id: "pr-009",
    title: "Developer Tooling Licenses",
    amount: 9800,
    department: "Engineering",
    status: "approved",
    priority: "medium",
    description: "Annual licenses for IDE, monitoring, and CI/CD tooling.",
    requested_at: "2026-03-17T10:30:00Z",
    approved: true,
  },
  {
    id: "pr-010",
    title: "Trade Show Booth Design",
    amount: 22000,
    department: "Marketing",
    status: "draft",
    priority: "high",
    description: "Design and build a booth for the upcoming industry trade show.",
    requested_at: "2026-03-18T09:15:00Z",
    approved: false,
  },
  {
    id: "pr-011",
    title: "Onboarding Welcome Kits",
    amount: 3200,
    department: "HR",
    status: "approved",
    priority: "low",
    description: "Welcome kits for new hires including branded merchandise and supplies.",
    requested_at: "2026-03-19T08:00:00Z",
    approved: true,
  },
  {
    id: "pr-012",
    title: "Data Center Cooling Upgrade",
    amount: 55000,
    department: "Engineering",
    status: "pending",
    priority: "high",
    description: "Upgrade cooling systems in the primary data center to handle new hardware.",
    requested_at: "2026-03-20T14:45:00Z",
    approved: false,
  },
];
