/**
 * Purchase Item schema definition
 *
 * Demonstrates:
 * - Derived property (line_total = quantity * unit_price)
 * - Field UI hints (format: currency)
 */

import type { SchemaDefinition } from "@linchkit/core";

export const purchaseItemSchema: SchemaDefinition = {
  name: "purchase_item",
  label: "t:schemas.purchase_item._label",
  presentation: {
    titleField: "name",
    summaryFields: ["quantity", "unit_price", "line_total"],
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "t:schemas.purchase_item.fields.name",
      ui: { importance: "primary" },
    },
    quantity: {
      type: "number",
      required: true,
      label: "t:schemas.purchase_item.fields.quantity",
      min: 1,
      ui: { importance: "primary", width: 3 },
    },
    unit_price: {
      type: "number",
      required: true,
      label: "t:schemas.purchase_item.fields.unit_price",
      min: 0,
      ui: { importance: "primary", format: "currency", width: 4 },
    },
    specification: {
      type: "text",
      label: "t:schemas.purchase_item.fields.specification",
      ui: { importance: "secondary" },
    },

    // Derived: line total = quantity * unit_price
    line_total: {
      type: "number",
      label: "t:schemas.purchase_item.fields.line_total",
      description: "Computed: quantity * unit_price",
      ui: { importance: "primary", format: "currency", width: 4 },
      derived: {
        type: "expression",
        strategy: "store",
        expr: "quantity * unit_price",
        deps: ["quantity", "unit_price"],
      },
    },
  },
};
