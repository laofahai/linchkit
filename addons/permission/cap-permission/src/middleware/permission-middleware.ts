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

/** The permission target (capability + action) a grant is matched against. */
interface PermissionTarget {
  capability: string;
  action: string;
}

/**
 * Resolve the authoritative permission target for a NON-ACTION dispatch that
 * carries it in `ctx.meta` rather than an action lookup.
 *
 * `command-layer.ts` documents this contract: a `skipActionSlots` dispatch (the
 * onchange / evolution routes) bypasses the ActionExecutor entirely, so there is
 * no `ctx.action` to derive a target from. Its synthetic `command` name exists
 * only for metrics/tracing — the authoritative target is published in `ctx.meta`
 * (`meta.evolution = { operation }`). Gate on that target so a NATURAL grant
 * (`grant.evolution.actions.<operation>`) authorizes it, instead of the synthetic
 * command name which no group would ever grant (→ silent default-deny / admin-only).
 *
 * Returns `null` when no recognised meta target is present, leaving the caller on
 * its normal action-based resolution. Only consulted for non-action dispatches
 * (`ctx.action` absent), so a real action's authorization is never affected.
 */
function resolveMetaTarget(ctx: CommandContext): PermissionTarget | null {
  const meta = ctx.meta as Record<string, unknown> | undefined;
  const evolution = meta?.evolution as { operation?: unknown } | undefined;
  if (evolution && typeof evolution.operation === "string" && evolution.operation.length > 0) {
    return { capability: "evolution", action: evolution.operation };
  }
  return null;
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

    // Resolve the permission target. A non-action dispatch (`skipActionSlots`,
    // no `ctx.action`) publishes its target in `ctx.meta` — honour that documented
    // contract first; otherwise fall back to the action-based resolution. Scoping
    // the meta lookup to `!action` guarantees a real action's target is unchanged.
    const metaTarget = action ? null : resolveMetaTarget(ctx);
    const capabilityName = metaTarget
      ? metaTarget.capability
      : resolveCapability
        ? resolveCapability(command, ctx)
        : (action?.entity ?? command);
    // The action name a grant is matched against: the meta target's operation for
    // a meta-targeted dispatch, else the (synthetic) command name as before.
    const actionName = metaTarget ? metaTarget.action : command;

    // ── Cache lookup ─────────────────────────────────────────
    // Key on the RESOLVED target (capability + action), not the raw command — a
    // meta-targeted dispatch reuses a synthetic command name across operations, so
    // keying on the command alone could collide distinct targets in the cache.
    const tenantId = (ctx.meta?.tenantId as string | undefined) ?? "";
    const schemaKey = action?.entity ?? "";
    const cacheKey = `perm:${tenantId}:${actor.id}:${capabilityName}:${actionName}:${schemaKey}`;
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
    const permResult = checkActionPermission(registry, actor, capabilityName, actionName);

    if (!permResult.allowed) {
      // Cache negative result too (prevents repeat lookups for denied actions)
      cacheManager?.set<CachedPermissionResult>(
        cacheKey,
        { allowed: false, reason: permResult.reason, decidedBy: permResult.decidedBy },
        { ttl: PERM_CACHE_TTL_MS, tags: cacheTags },
      );
      throw new AuthorizationError({
        code: "authz.action.denied",
        message: `Permission denied for action "${actionName}": ${permResult.reason ?? "no matching permission group"}`,
        requiredGroups: actor.groups.length > 0 ? undefined : ["(any)"],
        details: {
          action: actionName,
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
        // Consult BOTH the legacy `permissions[capability][entity]` and the
        // canonical `grant[entity]` field declarations.
        const fieldSources = [
          group.permissions?.[capabilityName]?.[action.entity]?.fields,
          group.grant?.[action.entity]?.fields,
        ];

        for (const fields of fieldSources) {
          if (!fields) continue;
          if (fields.visible) {
            for (const f of fields.visible) {
              visibleFields.add(f);
            }
          }
          if (fields.hidden) {
            for (const f of fields.hidden) {
              hiddenFields.add(f);
            }
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
