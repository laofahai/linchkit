/**
 * Revoke user from permission group action
 *
 * Removes a user's assignment from a permission group.
 */

import { defineAction } from "@linchkit/core";

export const revokeUserAction = defineAction({
  name: "revoke_user",
  entity: "permission_assignment",
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
  async handler(ctx) {
    const userId = ctx.input.user_id as string;
    const groupName = ctx.input.group_name as string;

    if (!userId?.trim()) {
      throw new Error("User ID is required");
    }
    if (!groupName?.trim()) {
      throw new Error("Group name is required");
    }

    // Find the assignment
    const assignments = await ctx.query("permission_assignment", {
      user_id: userId,
      group_name: groupName,
    });

    if (assignments.length === 0) {
      // Idempotent — if no assignment exists, return silently
      return { removed: false, message: "Assignment does not exist" };
    }

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const assignment = assignments[0]!;
    await ctx.delete("permission_assignment", assignment.id as string);

    // Emit revocation event
    ctx.emit("permission_assignment.revoked", {
      user_id: userId,
      group_name: groupName,
      revoked_by: ctx.actor.id,
    });

    return { removed: true, user_id: userId, group_name: groupName };
  },
});
