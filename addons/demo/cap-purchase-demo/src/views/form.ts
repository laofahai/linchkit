/**
 * Purchase request form view definition
 *
 * Demonstrates:
 * - Layout with groups, notebooks, and pages
 * - Derived fields displayed as readonly
 * - State-dependent action visibility
 * - has_many child records in notebook tab
 */

import type { ViewDefinition } from "@linchkit/core";

export const purchaseRequestFormView: ViewDefinition = {
  name: "purchase_request_form",
  schema: "purchase_request",
  type: "form",
  label: "t:schemas.purchase_request._label",
  fields: [
    { field: "title" },
    { field: "amount" },
    { field: "total_amount", readonly: true },
    { field: "display_title", readonly: true },
    { field: "department" },
    { field: "priority" },
    { field: "status", readonly: true },
    { field: "description" },
    {
      field: "notes",
      visibleWhen: { field: "priority", operator: "in", value: ["high", "urgent"] },
    },
    { field: "requester" },
    { field: "requester_email" },
    { field: "items" },
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
              { type: "field", field: "total_amount" },
            ],
          },
          {
            type: "group",
            children: [
              { type: "field", field: "priority" },
              { type: "field", field: "requester" },
              { type: "field", field: "requester_email" },
              { type: "field", field: "display_title" },
            ],
          },
        ],
      },
      { type: "separator" },
      {
        type: "group",
        columns: 1,
        children: [{ type: "field", field: "description", nolabel: true }],
      },
      {
        type: "group",
        columns: 1,
        children: [
          {
            type: "field",
            field: "notes",
            nolabel: true,
            visibleWhen: { field: "priority", operator: "in", value: ["high", "urgent"] },
          },
        ],
      },
      {
        type: "notebook",
        children: [
          {
            type: "page",
            title: "t:schemas.purchase_request.fields.items",
            children: [
              {
                type: "group",
                columns: 1,
                children: [{ type: "field", field: "items", nolabel: true }],
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
      label: "t:schemas.purchase_request.actions.submit_for_approval",
      position: "form-header",
      variant: "default",
    },
    {
      action: "approve_purchase_request",
      label: "t:schemas.purchase_request.actions.approve",
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
