/**
 * Purchase Request schema definition
 *
 * Demonstrates:
 * - Schema interfaces (implements "auditable")
 * - Derived/computed properties (total_amount, display_title)
 * - Data masking (requester_email marked sensitive)
 * - Field UI hints (importance, format, display)
 * - Rich field types (enum, state, datetime)
 */

import type { EntityDefinition } from "@linchkit/core";

export const purchaseRequestEntity: EntityDefinition = {
  name: "purchase_request",
  label: "t:entities.purchase_request._label",
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
      label: "t:entities.purchase_request.fields.title",
      ui: { importance: "primary" },
    },
    description: {
      type: "text",
      label: "t:entities.purchase_request.fields.description",
      ui: { editor: "rich" },
    },
    department_id: {
      type: "string",
      label: "t:entities.purchase_request.fields.department",
      description: "Foreign key to department (relationship managed via defineRelation)",
    },
    amount: {
      type: "number",
      required: true,
      label: "t:entities.purchase_request.fields.amount",
      ui: { importance: "primary", format: "currency" },
    },
    requester: {
      type: "string",
      label: "t:entities.purchase_request.fields.requester",
      ui: { importance: "primary" },
    },
    requester_email: {
      type: "string",
      required: true,
      label: "t:entities.purchase_request.fields.requester_email",
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
        { value: "low", label: "t:entities.purchase_request.enums.priority.low" },
        { value: "medium", label: "t:entities.purchase_request.enums.priority.medium" },
        { value: "high", label: "t:entities.purchase_request.enums.priority.high" },
        { value: "urgent", label: "t:entities.purchase_request.enums.priority.urgent" },
      ],
      label: "t:entities.purchase_request.fields.priority",
      ui: { importance: "primary", display: "badge" },
    },
    notes: { type: "text", label: "t:entities.purchase_request.fields.notes" },
    audit_notes: { type: "text", label: "t:entities.purchase_request.fields.audit_notes" },

    // Timestamp fields (auto-populated by automations)
    submitted_at: {
      type: "datetime",
      label: "t:entities.purchase_request.fields.submitted_at",
      immutable: true,
      ui: { importance: "detail" },
    },
    approved_at: {
      type: "datetime",
      label: "t:entities.purchase_request.fields.approved_at",
      immutable: true,
      ui: { importance: "detail" },
    },
    approved_by: {
      type: "string",
      label: "t:entities.purchase_request.fields.approved_by",
      immutable: true,
      ui: { importance: "detail" },
    },

    // Derived properties — computed, not user-input
    total_amount: {
      type: "number",
      label: "t:entities.purchase_request.fields.total_amount",
      description: "Sum of all line item amounts (quantity * unit_price)",
      ui: { importance: "primary", format: "currency" },
      derived: {
        type: "aggregate",
        strategy: "compute",
        source: { link: "request_to_items", entity: "purchase_item" },
        op: "sum",
        field: "line_total",
        deps: ["purchase_item.quantity", "purchase_item.unit_price"],
      },
    },
    display_title: {
      type: "string",
      label: "t:entities.purchase_request.fields.display_title",
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
