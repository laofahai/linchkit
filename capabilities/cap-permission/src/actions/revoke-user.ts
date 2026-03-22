/**
 * Revoke user from permission group action
 *
 * Removes a user's assignment from a permission group.
 */

import { defineAction } from "@linchkit/core";

export const revokeUserAction = defineAction({
  name: "revoke_user",
  schema: "permission_assignment",
  label: "Revoke User from Group",
  description: "Remove a user from a permission group",
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
    // TODO: Implement user revocation
    // 1. Find the permission_assignment record
    // 2. Delete the assignment
    // 3. Update user.groups array
    // 4. Emit 'permission_assignment.revoked' event
    throw new Error("Not implemented: revoke_user action");
  },
});
