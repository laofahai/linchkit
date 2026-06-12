/**
 * Product list view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const productListView: ViewDefinition = {
  name: "product_list",
  entity: "product",
  type: "list",
  label: "t:entities.product._labelPlural",
  fields: [
    { field: "name", sortable: true },
    { field: "category", sortable: true, width: 120 },
    { field: "barcode", sortable: true, width: 150 },
    { field: "case_pack_quantity", sortable: true, width: 100 },
    { field: "unit", width: 80 },
    { field: "unit_price", sortable: true, width: 120 },
    { field: "status", sortable: true, width: 100 },
  ],
  defaultSort: { field: "name", order: "asc" },
  pageSize: 10,
  actions: [
    {
      action: "create",
      label: "t:entities.product.actions.create",
      position: "toolbar",
      variant: "default",
    },
    { action: "edit", label: "t:common.edit", position: "row" },
    // No destructive hard-delete on the catalog list: a product referenced by a
    // purchase_item cannot be removed (itemToProduct is FK-RESTRICT, which keeps
    // historical purchase records intact). Catalog lifecycle is handled by the
    // `status` field — a discontinued product is set to `inactive` via edit,
    // not deleted.
  ],
};
