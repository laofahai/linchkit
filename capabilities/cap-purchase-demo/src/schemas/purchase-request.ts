/**
 * Purchase Request schema definition
 */

import type { SchemaDefinition } from "@linchkit/core";

export const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request submitted for approval",
  presentation: {
    titleField: "title",
  },
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    department: { type: "ref", target: "department", label: "Department" },
    amount: { type: "number", required: true, label: "Amount" },
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
    submitted_at: { type: "datetime", label: "Submitted At" },
    approved_at: { type: "datetime", label: "Approved At" },
    approved_by: { type: "string", label: "Approved By" },
  },
};
