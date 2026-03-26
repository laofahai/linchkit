/**
 * Department list view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const departmentListView: ViewDefinition = {
  name: "department_list",
  schema: "department",
  type: "list",
  label: "t:schemas.department._labelPlural",
  fields: [
    { field: "name", sortable: true },
    { field: "code", sortable: true, width: 120 },
    { field: "manager", sortable: true },
    { field: "budget_limit", sortable: true, width: 140 },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 10,
  actions: [
    { action: "create", label: "t:schemas.department.actions.create", position: "toolbar", variant: "default" },
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
