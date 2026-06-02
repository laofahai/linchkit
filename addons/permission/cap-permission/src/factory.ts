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
import type { CacheManager } from "@linchkit/core/server";
import type { z } from "zod";
import { assignUserAction } from "./actions/assign-user";
import { createGroupAction } from "./actions/create-group";
import { revokeUserAction } from "./actions/revoke-user";
import { updatePermissionsAction } from "./actions/update-permissions";
import { capPermissionConfig } from "./config";
import { createPermissionMiddleware } from "./middleware/permission-middleware";
import { permissionAssignmentSchema } from "./schemas/permission-assignment";
import { permissionGroupSchema } from "./schemas/permission-group";

export interface CapPermissionOptions {
  /**
   * Programmatic dependency — the permission registry instance.
   * When omitted, the permission middleware is not wired at definition time.
   * In that case, dev.ts auto-discovers permission groups from capabilities'
   * `extensions.permissionGroups` and wires the middleware with the
   * auto-built PermissionRegistry.
   */
  registry?: PermissionRegistry;
  /** Programmatic dependency — custom capability resolver */
  resolveCapability?: (actionName: string, ctx: CommandContext) => string;
  /**
   * Optional cache manager for caching permission decisions.
   * Cache key: perm:{tenantId}:{userId}:{command}:{schema}, 10min TTL.
   * Invalidated automatically whenever a write touches a permission entity
   * (`permission_assignment` via assign_user/revoke_user, `permission_group`
   * via create_group/update_permissions) — see CacheManager.PERMISSION_ENTITIES.
   */
  cacheManager?: CacheManager;

  /** Declarative configuration — validated by capPermissionConfig schema */
  config?: Partial<z.infer<typeof capPermissionConfig.schema>>;
}

export function createCapPermission(options?: CapPermissionOptions): CapabilityDefinition {
  const cfg = options?.config;

  // When an explicit registry is provided, wire middleware immediately.
  // Otherwise, dev.ts will wire the middleware using the auto-discovered
  // permissionRegistry from capabilities' extensions.permissionGroups.
  const middlewares: CapabilityMiddlewareRegistration[] | undefined = options?.registry
    ? [
        {
          slot: "permission" as const,
          handler: createPermissionMiddleware({
            registry: options.registry,
            publicActions: cfg?.publicActions as string[] | undefined,
            cacheManager: options.cacheManager,
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

    configSchema: capPermissionConfig.schema,
    config: cfg,

    dependencies: ["cap-auth"],

    entities: [permissionGroupSchema, permissionAssignmentSchema],
    actions: [createGroupAction, assignUserAction, revokeUserAction, updatePermissionsAction],

    extensions: middlewares ? { middlewares } : undefined,

    systemPermissions: ["database.read", "database.write", "event.emit"],
  });
}
