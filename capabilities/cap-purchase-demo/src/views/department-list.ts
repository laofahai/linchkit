/**
 * Department list view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const departmentListView: ViewDefinition = {
  name: "department_list",
  schema: "department",
  type: "list",
  label: "Departments",
  fields: [
    { field: "name", sortable: true },
    { field: "code", sortable: true, width: 120 },
    { field: "manager", sortable: true },
    { field: "budget_limit", sortable: true, width: 140 },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 10,
  actions: [
    { action: "create", label: "New Department", position: "toolbar", variant: "default" },
    { action: "edit", label: "Edit", position: "row" },
    {
      action: "delete",
      label: "Delete",
      position: "row",
      variant: "destructive",
      confirm: "Are you sure you want to delete this department?",
    },
  ],
};
