/**
 * Department schema definition
 */

import type { SchemaDefinition } from "@linchkit/core";

export const departmentSchema: SchemaDefinition = {
  name: "department",
  label: "Department",
  presentation: {
    titleField: "name",
  },
  fields: {
    name: { type: "string", required: true, label: "Name" },
    code: { type: "string", required: true, label: "Code" },
    manager: { type: "string", label: "Manager" },
  },
};
