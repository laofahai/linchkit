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
import type { CacheManager } from "@linchkit/core/server";
import {
  checkActionPermission,
  resolveConditionVariables,
  resolveDataAccess,
} from "@linchkit/core/server";

// ── Types ─────────────────────────────────────────────────

/** Cached permission decision for a single actor + action + schema combination */
interface CachedPermissionResult {
  allowed: boolean;
  reason?: string;
  decidedBy?: string;
  dataAccess?: {
    read: unknown;
    write: unknown;
  };
  fieldAccess?: {
    visible?: string[];
    hidden?: string[];
  };
}

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
  /**
   * Cache manager for caching permission decisions.
   * When provided, permission check results are cached per actor+tenant+action+schema.
   * Cache key: perm:{tenantId}:{userId}:{command}:{schema}
   * TTL: 10 minutes. Invalidated by permission-related write events (via CacheManager).
   */
  cacheManager?: CacheManager;
}

/** TTL for permission decision cache entries: 10 minutes (spec §4) */
const PERM_CACHE_TTL_MS = 10 * 60 * 1000;

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
  const { registry, resolveCapability, publicActions = [], cacheManager } = options;

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
      : (action?.entity ?? command);

    // ── Cache lookup ─────────────────────────────────────────
    const tenantId = (ctx.meta?.tenantId as string | undefined) ?? "";
    const schemaKey = action?.entity ?? "";
    const cacheKey = `perm:${tenantId}:${actor.id}:${command}:${schemaKey}`;
    const cacheTags = [`perm:${tenantId}`, `perm`];

    if (cacheManager) {
      const cached = cacheManager.get<CachedPermissionResult>(cacheKey);
      if (cached !== undefined) {
        if (!cached.allowed) {
          throw new AuthorizationError({
            code: "authz.action.denied",
            message: `Permission denied for action "${command}": ${cached.reason ?? "no matching permission group"}`,
            requiredGroups: actor.groups.length > 0 ? undefined : ["(any)"],
            details: {
              action: command,
              capability: capabilityName,
              decidedBy: cached.decidedBy,
            },
          });
        }
        if (cached.dataAccess) {
          ctx.meta.dataAccess = cached.dataAccess;
        }
        if (cached.fieldAccess) {
          ctx.meta.fieldAccess = cached.fieldAccess;
        }
        await next();
        return;
      }
    }

    // ── Step 1: Check action permission ──────────────────────
    const permResult = checkActionPermission(registry, actor, capabilityName, command);

    if (!permResult.allowed) {
      // Cache negative result too (prevents repeat lookups for denied actions)
      cacheManager?.set<CachedPermissionResult>(
        cacheKey,
        { allowed: false, reason: permResult.reason, decidedBy: permResult.decidedBy },
        { ttl: PERM_CACHE_TTL_MS, tags: cacheTags },
      );
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

    // ── Step 2: Resolve data access conditions ───────────────
    let resolvedDataAccess: CachedPermissionResult["dataAccess"] | undefined;

    if (action?.entity) {
      const readAccess = resolveDataAccess(registry, actor, capabilityName, action.entity, "read");
      const writeAccess = resolveDataAccess(
        registry,
        actor,
        capabilityName,
        action.entity,
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

      resolvedDataAccess = { read: resolvedReadAccess, write: resolvedWriteAccess };
      ctx.meta.dataAccess = resolvedDataAccess;
    }

    // ── Step 3: Resolve field-level visibility ───────────────
    let resolvedFieldAccess: CachedPermissionResult["fieldAccess"] | undefined;

    if (action?.entity) {
      const groups = registry.resolveActorPermissions(actor);
      const visibleFields = new Set<string>();
      const hiddenFields = new Set<string>();

      for (const group of groups) {
        const capPerms = group.permissions[capabilityName];
        if (!capPerms) continue;

        const schemaPerms = capPerms[action.entity];
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

      if (visibleFields.size > 0 || hiddenFields.size > 0) {
        resolvedFieldAccess = {
          visible: visibleFields.size > 0 ? Array.from(visibleFields) : undefined,
          hidden: hiddenFields.size > 0 ? Array.from(hiddenFields) : undefined,
        };
        ctx.meta.fieldAccess = resolvedFieldAccess;
      }
    }

    // ── Cache positive result ─────────────────────────────────
    if (cacheManager) {
      cacheManager.set<CachedPermissionResult>(
        cacheKey,
        {
          allowed: true,
          dataAccess: resolvedDataAccess,
          fieldAccess: resolvedFieldAccess,
        },
        { ttl: PERM_CACHE_TTL_MS, tags: cacheTags },
      );
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
