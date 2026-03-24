/**
 * Assign user to permission group action
 *
 * Creates a permission_assignment record linking a user to a group.
 */

import { defineAction } from "@linchkit/core";

export const assignUserAction = defineAction({
  name: "assign_user",
  schema: "permission_assignment",
  label: "Assign User to Group",
  description: "Assign a user to a permission group",
  input: {
    user_id: {
      type: "string",
      label: "User ID",
      required: true,
    },
    group_name: {
      type: "string",
      label: "Permission Group",
      required: true,
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: true,
  },
  exposure: { http: true, ui: true, cli: true, mcp: false },
  permissions: {
    groups: ["system_admin"],
  },
  async handler(_ctx) {
    // TODO: Implement user assignment
    // 1. Validate user exists
    // 2. Validate group exists in PermissionRegistry
    // 3. Check if assignment already exists (idempotent)
    // 4. Create permission_assignment record
    // 5. Update user.groups array
    // 6. Emit 'permission_assignment.created' event
    throw new Error("Not implemented: assign_user action");
  },
});
