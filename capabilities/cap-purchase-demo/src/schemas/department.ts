/**
 * Department schema definition
 *
 * Demonstrates:
 * - Schema presentation metadata (icon, summaryFields)
 * - Field UI hints
 */

import type { SchemaDefinition } from "@linchkit/core";

export const departmentSchema: SchemaDefinition = {
  name: "department",
  label: "Department",
  description: "Organizational department that owns purchase requests",
  presentation: {
    titleField: "name",
    subtitleField: "manager",
    summaryFields: ["code", "manager"],
    icon: "building-2",
  },
  fields: {
    name: {
      type: "string",
      required: true,
      label: "Name",
      unique: true,
      ui: { importance: "primary" },
    },
    code: {
      type: "string",
      required: true,
      label: "Code",
      unique: true,
      ui: { importance: "primary", width: 3 },
    },
    manager: {
      type: "string",
      label: "Manager",
      ui: { importance: "primary" },
    },
    budget_limit: {
      type: "number",
      label: "Budget Limit",
      description: "Maximum single purchase amount for this department",
      min: 0,
      ui: { format: "currency", importance: "secondary" },
    },
  },
};
