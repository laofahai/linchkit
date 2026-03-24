/**
 * Purchase Item schema definition
 */

import type { SchemaDefinition } from "@linchkit/core";

export const purchaseItemSchema: SchemaDefinition = {
  name: "purchase_item",
  label: "Purchase Item",
  fields: {
    name: { type: "string", required: true, label: "Item Name" },
    quantity: { type: "number", required: true, label: "Quantity" },
    unit_price: { type: "number", required: true, label: "Unit Price" },
    specification: { type: "text", label: "Specification" },
  },
};
