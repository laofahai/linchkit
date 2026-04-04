/**
 * Create permission group action
 *
 * Creates a new permission group with the specified access rules.
 */

import { defineAction } from "@linchkit/core";

export const createGroupAction = defineAction({
  name: "create_group",
  entity: "permission_group",
  label: "Create Permission Group",
  description: "Create a new permission group with access rules",
  input: {
    name: {
      type: "string",
      label: "Group Name",
      required: true,
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
    },
    constraints: {
      type: "json",
      label: "Constraints",
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
    const name = ctx.input.name as string;
    const label = ctx.input.label as string;
    const description = (ctx.input.description as string) ?? "";
    const permissions = ctx.input.permissions as Record<string, unknown>;
    const constraints = (ctx.input.constraints as Record<string, unknown>) ?? undefined;

    if (!name?.trim()) {
      throw new Error("Group name is required");
    }
    if (!label?.trim()) {
      throw new Error("Group label is required");
    }
    if (!permissions || typeof permissions !== "object") {
      throw new Error("Permissions must be a valid object");
    }

    // Check for duplicate group name
    const existing = await ctx.query("permission_group", { name });
    if (existing.length > 0) {
      throw new Error(`Permission group "${name}" already exists`);
    }

    // Create the permission_group record
    const record = await ctx.create("permission_group", {
      name,
      label,
      description,
      permissions,
      constraints,
      is_system: false,
    });

    // Emit creation event
    ctx.emit("permission_group.created", {
      group_name: name,
      created_by: ctx.actor.id,
    });

    return record;
  },
});
