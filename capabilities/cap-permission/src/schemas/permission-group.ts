/**
 * Permission group schema definition
 *
 * Stores permission group configurations. Each group defines
 * what actions, data, and fields are accessible per capability/schema.
 */

import { defineSchema } from "@linchkit/core";

export const permissionGroupSchema = defineSchema({
  name: "permission_group",
  label: "Permission Group",
  description: "Permission group definition with per-capability/schema access rules",
  fields: {
    name: {
      type: "string",
      label: "Group Name",
      required: true,
      unique: true,
      description: "Unique identifier for this permission group",
    },
    label: {
      type: "string",
      label: "Display Name",
      required: true,
    },
    description: {
      type: "text",
      label: "Description",
    },
    permissions: {
      type: "json",
      label: "Permissions",
      required: true,
      description: "Structured permissions object: { capability: { schema: SchemaPermissions } }",
    },
    constraints: {
      type: "json",
      label: "Constraints",
      description: "AI/special actor constraints (rate limits, approval requirements)",
    },
    is_system: {
      type: "boolean",
      label: "System Group",
      default: false,
      description: "System groups cannot be deleted or modified by non-admin users",
    },
  },
  presentation: {
    titleField: "label",
    subtitleField: "name",
    summaryFields: ["name", "label", "is_system"],
    icon: "shield",
  },
});
