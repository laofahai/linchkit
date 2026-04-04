/**
 * Assign user to permission group action
 *
 * Creates a permission_assignment record linking a user to a group.
 */

import { defineAction } from "@linchkit/core";

export const assignUserAction = defineAction({
  name: "assign_user",
  entity: "permission_assignment",
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
  async handler(ctx) {
    const userId = ctx.input.user_id as string;
    const groupName = ctx.input.group_name as string;

    if (!userId?.trim()) {
      throw new Error("User ID is required");
    }
    if (!groupName?.trim()) {
      throw new Error("Group name is required");
    }

    // Validate group exists
    const groups = await ctx.query("permission_group", { name: groupName });
    if (groups.length === 0) {
      throw new Error(`Permission group "${groupName}" does not exist`);
    }

    // Check if assignment already exists (idempotent — return existing)
    const existing = await ctx.query("permission_assignment", {
      user_id: userId,
      group_name: groupName,
    });
    if (existing.length > 0) {
      return existing[0];
    }

    // Create the assignment record
    const record = await ctx.create("permission_assignment", {
      user_id: userId,
      group_name: groupName,
      assigned_by: ctx.actor.id,
      assigned_at: new Date().toISOString(),
    });

    // Emit assignment event
    ctx.emit("permission_assignment.created", {
      user_id: userId,
      group_name: groupName,
      assigned_by: ctx.actor.id,
    });

    return record;
  },
});
