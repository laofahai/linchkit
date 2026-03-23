/**
 * Permission middleware — fills the Command Layer "permission" slot
 *
 * Uses PermissionRegistry + checkActionPermission + resolveDataAccess from @linchkit/core.
 *
 * Pipeline:
 * 1. Read actor.groups from ctx.actor (set by auth middleware)
 * 2. Resolve all permission groups for this actor
 * 3. Check if the actor can execute the requested action
 * 4. Resolve data access conditions (row-level filtering)
 * 5. Inject data access conditions into ctx.meta for downstream use
 */

import type { CommandContext, MiddlewareHandler, MiddlewareRegistration } from "@linchkit/core";
import { AuthorizationError, type PermissionRegistry } from "@linchkit/core";
import {
  checkActionPermission,
  resolveConditionVariables,
  resolveDataAccess,
} from "@linchkit/core/server";

// ── Types ─────────────────────────────────────────────────

export interface PermissionMiddlewareOptions {
  /** The permission registry containing all group definitions */
  registry: PermissionRegistry;
  /**
   * Resolve capability name from an action name.
   * Actions are namespaced by capability (e.g. "cap_auth.login").
   * This function extracts the capability name.
   * Default: uses action.schema as capability lookup key.
   */
  resolveCapability?: (actionName: string, ctx: CommandContext) => string;
  /**
   * Actions that bypass permission checks entirely (e.g. login, health).
   * These are typically actions with exposure: "all" and no auth requirement.
   */
  publicActions?: string[];
}

// ── Middleware factory ─────────────────────────────────────

/**
 * Create the permission middleware handler.
 *
 * Usage:
 * ```ts
 * const permHandler = createPermissionMiddleware({
 *   registry: permissionRegistry,
 *   publicActions: ['login', 'health'],
 * });
 * ```
 */
export function createPermissionMiddleware(
  options: PermissionMiddlewareOptions,
): MiddlewareHandler {
  const { registry, resolveCapability, publicActions = [] } = options;

  return async (ctx: CommandContext, next: () => Promise<void>): Promise<void> => {
    const { actor, command, action } = ctx;

    // Skip permission check for public actions
    if (publicActions.includes(command)) {
      await next();
      return;
    }

    // Skip for system actors (internal calls) but not anonymous
    if (actor.type === "system" && actor.id !== "anonymous") {
      await next();
      return;
    }

    // Resolve capability name from action
    const capabilityName = resolveCapability
      ? resolveCapability(command, ctx)
      : (action?.schema ?? command);

    // Step 1: Check action permission
    const permResult = checkActionPermission(registry, actor, capabilityName, command);

    if (!permResult.allowed) {
      throw new AuthorizationError({
        code: "authz.action.denied",
        message: `Permission denied for action "${command}": ${permResult.reason ?? "no matching permission group"}`,
        requiredGroups: actor.groups.length > 0 ? undefined : ["(any)"],
        details: {
          action: command,
          capability: capabilityName,
          decidedBy: permResult.decidedBy,
        },
      });
    }

    // Step 2: Resolve data access conditions for the target schema
    if (action?.schema) {
      const readAccess = resolveDataAccess(registry, actor, capabilityName, action.schema, "read");

      const writeAccess = resolveDataAccess(
        registry,
        actor,
        capabilityName,
        action.schema,
        "write",
      );

      // Resolve variable references (e.g. $actor.id) in conditions
      const resolvedReadAccess =
        typeof readAccess === "object" && "field" in readAccess
          ? resolveConditionVariables(readAccess, actor)
          : readAccess;

      const resolvedWriteAccess =
        typeof writeAccess === "object" && "field" in writeAccess
          ? resolveConditionVariables(writeAccess, actor)
          : writeAccess;

      // Inject data access conditions into ctx.meta for use by data layer
      ctx.meta.dataAccess = {
        read: resolvedReadAccess,
        write: resolvedWriteAccess,
      };
    }

    // Step 3: Resolve field-level visibility
    // Field-level filtering is handled at the query/response layer,
    // but we attach the resolved field permissions for downstream use
    if (action?.schema) {
      const groups = registry.resolveActorPermissions(actor);
      const visibleFields = new Set<string>();
      const hiddenFields = new Set<string>();

      for (const group of groups) {
        const capPerms = group.permissions[capabilityName];
        if (!capPerms) continue;

        const schemaPerms = capPerms[action.schema];
        if (!schemaPerms?.fields) continue;

        if (schemaPerms.fields.visible) {
          for (const f of schemaPerms.fields.visible) {
            visibleFields.add(f);
          }
        }
        if (schemaPerms.fields.hidden) {
          for (const f of schemaPerms.fields.hidden) {
            hiddenFields.add(f);
          }
        }
      }

      // Only set if any group declared field-level permissions
      if (visibleFields.size > 0 || hiddenFields.size > 0) {
        ctx.meta.fieldAccess = {
          visible: visibleFields.size > 0 ? Array.from(visibleFields) : undefined,
          hidden: hiddenFields.size > 0 ? Array.from(hiddenFields) : undefined,
        };
      }
    }

    await next();
  };
}

// ── Middleware registration helper ────────────────────────

/**
 * Create a MiddlewareRegistration for the permission slot.
 */
export function createPermissionMiddlewareRegistration(
  options: PermissionMiddlewareOptions,
): MiddlewareRegistration {
  return {
    name: "cap-permission",
    slot: "permission",
    order: 50,
    handler: createPermissionMiddleware(options),
  };
}
