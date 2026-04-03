/**
 * Department schema definition
 *
 * Demonstrates:
 * - Schema presentation metadata (icon, summaryFields)
 * - Field UI hints
 */

import type { EntityDefinition } from "@linchkit/core";

export const departmentEntity: EntityDefinition = {
  name: "department",
  label: "t:schemas.department._label",
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
      label: "t:schemas.department.fields.name",
      unique: true,
      ui: { importance: "primary" },
    },
    code: {
      type: "string",
      required: true,
      label: "t:schemas.department.fields.code",
      unique: true,
      ui: { importance: "primary", width: 3 },
    },
    manager: {
      type: "string",
      label: "t:schemas.department.fields.manager",
      ui: { importance: "primary" },
    },
    budget_limit: {
      type: "number",
      label: "t:schemas.department.fields.budget_limit",
      description: "Maximum single purchase amount for this department",
      min: 0,
      ui: { format: "currency", importance: "secondary" },
    },
  },
};
