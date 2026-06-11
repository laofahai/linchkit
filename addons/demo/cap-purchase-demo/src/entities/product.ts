/**
 * Product schema definition — the purchase-demo product catalog.
 *
 * Office-supply focused catalog so purchase items can reference a concrete
 * product instead of free-text names. Demonstrates:
 * - Enum fields (category, status)
 * - Unique + pattern constraints (barcode)
 * - Numeric constraints (case_pack_quantity >= 1, unit_price >= 0)
 */

import type { EntityDefinition } from "@linchkit/core";

export const productEntity: EntityDefinition = {
  name: "product",
  label: "t:entities.product._label",
  description: "Catalog product that purchase items can reference directly",

  presentation: {
    titleField: "name",
    subtitleField: "specification",
    badgeField: "status",
    summaryFields: ["category", "barcode", "unit_price"],
    icon: "package",
  },

  fields: {
    name: {
      type: "string",
      required: true,
      label: "t:entities.product.fields.name",
      ui: { importance: "primary" },
    },
    category: {
      type: "enum",
      options: [
        { value: "stationery", label: "t:entities.product.enums.category.stationery" },
        { value: "paper", label: "t:entities.product.enums.category.paper" },
        { value: "electronics", label: "t:entities.product.enums.category.electronics" },
        { value: "cleaning", label: "t:entities.product.enums.category.cleaning" },
        { value: "other", label: "t:entities.product.enums.category.other" },
      ],
      default: "other",
      label: "t:entities.product.fields.category",
      ui: { importance: "primary", display: "badge" },
    },
    specification: {
      type: "text",
      label: "t:entities.product.fields.specification",
      ui: { importance: "secondary" },
    },
    barcode: {
      type: "string",
      unique: true,
      // EAN-8 through GTIN-14 — digits only
      pattern: "^[0-9]{8,14}$",
      label: "t:entities.product.fields.barcode",
      ui: { importance: "primary", width: 4 },
    },
    case_pack_quantity: {
      type: "number",
      min: 1,
      default: 1,
      label: "t:entities.product.fields.case_pack_quantity",
      description: "Units per case (箱规)",
      ui: { importance: "secondary", width: 3 },
    },
    unit: {
      type: "string",
      label: "t:entities.product.fields.unit",
      description: "Unit of measure, e.g. 个/盒/箱",
      ui: { importance: "secondary", width: 3 },
    },
    unit_price: {
      type: "number",
      min: 0,
      label: "t:entities.product.fields.unit_price",
      ui: { importance: "primary", format: "currency", width: 4 },
    },
    status: {
      type: "enum",
      options: [
        { value: "active", label: "t:entities.product.enums.status.active" },
        { value: "inactive", label: "t:entities.product.enums.status.inactive" },
      ],
      default: "active",
      label: "t:entities.product.fields.status",
      ui: { importance: "primary", display: "badge", width: 3 },
    },
  },
};
