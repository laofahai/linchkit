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
  label: "Purchase Item",
  presentation: {
    titleField: "name",
    summaryFields: ["quantity", "unit_price", "line_total"],
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "Item Name",
      ui: { importance: "primary" },
    },
    quantity: {
      type: "number",
      required: true,
      label: "Quantity",
      min: 1,
      ui: { importance: "primary", width: 3 },
    },
    unit_price: {
      type: "number",
      required: true,
      label: "Unit Price",
      min: 0,
      ui: { importance: "primary", format: "currency", width: 4 },
    },
    specification: {
      type: "text",
      label: "Specification",
      ui: { importance: "secondary" },
    },

    // Derived: line total = quantity * unit_price
    line_total: {
      type: "number",
      label: "Line Total",
      description: "Computed: quantity * unit_price",
      ui: { importance: "primary", format: "currency", width: 4 },
      derived: {
        type: "expression",
        strategy: "compute",
        expression: "quantity * unit_price",
        deps: ["quantity", "unit_price"],
      },
    },
  },
};
