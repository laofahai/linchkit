/**
 * Product form view definition
 */

import type { ViewDefinition } from "@linchkit/core";

export const productFormView: ViewDefinition = {
  name: "product_form",
  entity: "product",
  type: "form",
  label: "t:entities.product._label",
  fields: [
    { field: "name" },
    { field: "category" },
    { field: "barcode" },
    { field: "status" },
    { field: "case_pack_quantity" },
    { field: "unit" },
    { field: "unit_price" },
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
              { type: "field", field: "name" },
              { type: "field", field: "category" },
              { type: "field", field: "barcode" },
              { type: "field", field: "status" },
            ],
          },
          {
            type: "group",
            children: [
              { type: "field", field: "unit_price" },
              { type: "field", field: "unit" },
              { type: "field", field: "case_pack_quantity" },
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
