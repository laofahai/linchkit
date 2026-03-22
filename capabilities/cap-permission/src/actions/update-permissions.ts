/**
 * Update permissions action
 *
 * Updates the permission rules of an existing permission group.
 */

import { defineAction } from "@linchkit/core";

export const updatePermissionsAction = defineAction({
  name: "update_permissions",
  schema: "permission_group",
  label: "Update Group Permissions",
  description: "Update the permission rules of an existing group",
  input: {
    group_name: {
      type: "string",
      label: "Group Name",
      required: true,
    },
    permissions: {
      type: "json",
      label: "Permissions",
      required: true,
      description: "New permissions object (replaces existing)",
    },
    constraints: {
      type: "json",
      label: "Constraints",
      description: "Updated constraints (optional)",
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: false,
  },
  exposure: { http: true, ui: true, cli: true, mcp: false },
  permissions: {
    groups: ["system_admin"],
  },
  async handler(_ctx) {
    // TODO: Implement permission update
    // 1. Find the permission_group record
    // 2. Validate new permissions structure
    // 3. Update the record
    // 4. Re-register in PermissionRegistry (replace)
    // 5. Emit 'permission_group.updated' event
    throw new Error("Not implemented: update_permissions action");
  },
});
