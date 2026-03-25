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
  async handler(ctx) {
    const groupName = ctx.input.group_name as string;
    const permissions = ctx.input.permissions as Record<string, unknown>;
    const constraints = ctx.input.constraints as Record<string, unknown> | undefined;

    if (!groupName?.trim()) {
      throw new Error("Group name is required");
    }
    if (!permissions || typeof permissions !== "object") {
      throw new Error("Permissions must be a valid object");
    }

    // Find the existing group
    const groups = await ctx.query("permission_group", { name: groupName });
    if (groups.length === 0) {
      throw new Error(`Permission group "${groupName}" does not exist`);
    }

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const group = groups[0]!;
    const groupId = group.id as string;

    // Build update payload
    const updateData: Record<string, unknown> = { permissions };
    if (constraints !== undefined) {
      updateData.constraints = constraints;
    }

    // Update the record
    const updated = await ctx.update("permission_group", groupId, updateData);

    // Emit update event
    ctx.emit("permission_group.updated", {
      group_name: groupName,
      updated_by: ctx.actor.id,
    });

    return updated;
  },
});
