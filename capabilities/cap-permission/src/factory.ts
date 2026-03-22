/**
 * createCapPermission — Factory that wires a PermissionRegistry into the
 * cap-permission capability, producing a fully-wired CapabilityDefinition
 * with the permission middleware registered in extensions.
 */

import type {
  CapabilityDefinition,
  CapabilityMiddlewareRegistration,
  CommandContext,
} from "@linchkit/core";
import { defineCapability, type PermissionRegistry } from "@linchkit/core";
import { assignUserAction } from "./actions/assign-user";
import { createGroupAction } from "./actions/create-group";
import { revokeUserAction } from "./actions/revoke-user";
import { updatePermissionsAction } from "./actions/update-permissions";
import { createPermissionMiddleware } from "./middleware/permission-middleware";
import { permissionAssignmentSchema } from "./schemas/permission-assignment";
import { permissionGroupSchema } from "./schemas/permission-group";

export interface CapPermissionOptions {
  registry: PermissionRegistry;
  publicActions?: string[];
  resolveCapability?: (actionName: string, ctx: CommandContext) => string;
}

export function createCapPermission(options?: CapPermissionOptions): CapabilityDefinition {
  const middlewares: CapabilityMiddlewareRegistration[] | undefined = options
    ? [
        {
          slot: "permission" as const,
          handler: createPermissionMiddleware({
            registry: options.registry,
            publicActions: options.publicActions,
          }),
          priority: 50,
        },
      ]
    : undefined;

  return defineCapability({
    name: "cap-permission",
    label: "Permission Management",
    description: "Permission group management, user assignment, and permission slot middleware",
    type: "standard",
    category: "system",
    version: "0.0.1",

    dependencies: ["cap-auth"],

    schemas: [permissionGroupSchema, permissionAssignmentSchema],
    actions: [createGroupAction, assignUserAction, revokeUserAction, updatePermissionsAction],

    extensions: middlewares ? { middlewares } : undefined,

    systemPermissions: ["database.read", "database.write", "event.emit"],
  });
}
