/**
 * Purchase request list view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const purchaseRequestListView: ViewDefinition = {
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
