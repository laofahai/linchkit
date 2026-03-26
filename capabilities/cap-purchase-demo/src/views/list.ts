/**
 * Purchase request list view definition
 *
 * Demonstrates:
 * - Derived field in list columns (total_amount)
 * - Sorted by priority by default
 */

import type { ViewDefinition } from "@linchkit/core";

export const purchaseRequestListView: ViewDefinition = {
  name: "purchase_request_list",
  schema: "purchase_request",
  type: "list",
  label: "t:schemas.purchase_request._labelPlural",
  fields: [
    { field: "title", sortable: true },
    { field: "requester", sortable: true, width: 140 },
    { field: "amount", sortable: true, width: 120 },
    { field: "total_amount", sortable: true, width: 130 },
    { field: "department", sortable: true },
    { field: "priority", sortable: true, width: 100 },
    { field: "status", sortable: true, width: 120 },
  ],
  defaultSort: { field: "title", order: "asc" },
  pageSize: 10,
  actions: [
    { action: "create", label: "t:schemas.purchase_request.actions.create_request", position: "toolbar", variant: "default" },
    { action: "edit", label: "t:common.edit", position: "row" },
    {
      action: "delete",
      label: "t:common.delete",
      position: "row",
      variant: "destructive",
      confirm: "t:confirm.deleteDescription",
    },
  ],
};
