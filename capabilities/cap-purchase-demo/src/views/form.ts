/**
 * Purchase request form view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const purchaseRequestFormView: ViewDefinition = {
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
