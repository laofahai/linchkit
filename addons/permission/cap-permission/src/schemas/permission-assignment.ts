/**
 * Permission assignment schema definition
 *
 * Maps users to permission groups. A user can belong to multiple groups.
 * Permissions are merged using the explicit-deny-wins strategy.
 */

import { defineEntity } from "@linchkit/core";

export const permissionAssignmentSchema = defineEntity({
  name: "permission_assignment",
  label: "Permission Assignment",
  description: "User-to-permission-group assignment",
  fields: {
    user_id: {
      type: "string",
      label: "User",
      required: true,
      description: "Foreign key to user (relationship managed via defineRelation)",
    },
    group_name: {
      type: "string",
      label: "Permission Group",
      required: true,
      description: "Name of the permission group",
    },
    assigned_by: {
      type: "string",
      label: "Assigned By",
      description: "Foreign key to user (relationship managed via defineRelation)",
    },
    assigned_at: {
      type: "datetime",
      label: "Assigned At",
    },
  },
  presentation: {
    titleField: "group_name",
    subtitleField: "user_id",
    summaryFields: ["user_id", "group_name", "assigned_at"],
    icon: "user-check",
  },
});
