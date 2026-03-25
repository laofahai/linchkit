/**
 * Purchase Request schema definition
 *
 * Demonstrates:
 * - Schema interfaces (implements "auditable")
 * - Derived/computed properties (total_amount, display_title)
 * - Data masking (requester_email marked sensitive)
 * - Field UI hints (importance, format, display)
 * - Rich field types (enum, state, ref, datetime)
 */

import type { SchemaDefinition } from "@linchkit/core";

export const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request submitted for approval",

  implements: ["auditable"],

  presentation: {
    titleField: "title",
    subtitleField: "display_title",
    badgeField: "status",
    summaryFields: ["total_amount", "priority", "requester"],
    icon: "file-text",
  },

  fields: {
    title: {
      type: "string",
      required: true,
      label: "Title",
      ui: { importance: "primary" },
    },
    description: { type: "text", label: "Description" },
    department: { type: "ref", target: "department", label: "Department" },
    amount: {
      type: "number",
      required: true,
      label: "Amount",
      ui: { importance: "primary", format: "currency" },
    },
    requester: {
      type: "string",
      label: "Requester",
      ui: { importance: "primary" },
    },
    requester_email: {
      type: "string",
      label: "Requester Email",
      format: "email",
      sensitive: true,
      masking: {
        strategy: "partial",
        visibleChars: 4,
        position: "end",
      },
      description: "Email of the requester — masked for non-admin users",
    },
    status: {
      type: "state",
      machine: "purchase_lifecycle",
      default: "draft",
      ui: { importance: "primary", display: "badge" },
    },
    priority: {
      type: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ],
      label: "Priority",
      ui: { importance: "primary", display: "badge" },
    },
    notes: { type: "text", label: "Notes" },
    audit_notes: { type: "text", label: "Audit Notes" },

    // Timestamp fields (auto-populated by automations)
    submitted_at: {
      type: "datetime",
      label: "Submitted At",
      immutable: true,
      ui: { importance: "detail" },
    },
    approved_at: {
      type: "datetime",
      label: "Approved At",
      immutable: true,
      ui: { importance: "detail" },
    },
    approved_by: {
      type: "string",
      label: "Approved By",
      immutable: true,
      ui: { importance: "detail" },
    },

    // Derived properties — computed, not user-input
    total_amount: {
      type: "number",
      label: "Total Amount",
      description: "Sum of all line item amounts (quantity * unit_price)",
      ui: { importance: "primary", format: "currency" },
      derived: {
        type: "aggregate",
        strategy: "compute",
        source: "purchase_item",
        operation: "sum",
        expression: "quantity * unit_price",
        deps: ["purchase_item.quantity", "purchase_item.unit_price"],
      },
    },
    display_title: {
      type: "string",
      label: "Display Title",
      description: "Concatenation of requester name and description",
      derived: {
        type: "concat",
        strategy: "compute",
        separator: " — ",
        fields: ["requester", "description"],
        deps: ["requester", "description"],
      },
    },
  },
};
