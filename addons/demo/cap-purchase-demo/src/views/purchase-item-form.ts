/**
 * Purchase item form view definition
 *
 * Explicitly includes the `product` relation field (semantic name of the
 * item_to_product many_to_one relation) so the form renders a product
 * selector — the auto-generated fallback form only includes scalar entity
 * fields and would NOT surface the relation. Mirrors how the purchase
 * request form exposes `department`.
 */

import type { ViewDefinition } from "@linchkit/core";

export const purchaseItemFormView: ViewDefinition = {
  name: "purchase_item_form",
  entity: "purchase_item",
  type: "form",
  label: "t:entities.purchase_item._label",
  fields: [
    { field: "product" },
    { field: "name" },
    { field: "quantity" },
    { field: "unit_price" },
    { field: "line_total", readonly: true },
    { field: "specification" },
  ],
  layout: {
    nodes: [
      {
        type: "group",
        children: [
          {
            type: "group",
            children: [
              { type: "field", field: "product" },
              { type: "field", field: "name" },
            ],
          },
          {
            type: "group",
            children: [
              { type: "field", field: "quantity" },
              { type: "field", field: "unit_price" },
              { type: "field", field: "line_total" },
            ],
          },
        ],
      },
      { type: "separator" },
      {
        type: "group",
        columns: 1,
        children: [{ type: "field", field: "specification" }],
      },
    ],
  },
};
