/**
 * Purchase Request schema definition
 */

import type { SchemaDefinition } from "@linchkit/core";

export const purchaseRequestSchema: SchemaDefinition = {
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
