/**
 * Tenant Isolation
 *
 * Row-level tenant isolation for multi-tenancy.
 *
 * Two components:
 * 1. TenantIsolationMiddleware — fills the CommandLayer "tenant" slot,
 *    resolving tenantId from actor context onto CommandContext.
 * 2. createTenantAwareDataProvider — wraps any DataProvider to enforce
 *    tenant_id filtering on every operation. Cross-tenant access is blocked
 *    unless the actor has system-level permission.
 *
 * See spec 30_multi_tenant.md.
 */

import type { DataProvider, DataQueryOptions } from "../engine/action-engine";
import type { MiddlewareRegistration } from "../engine/command-layer";
import { AuthorizationError } from "../errors";

// ── Tenant resolution ───────────────────────────────────────

/** Strategy for resolving tenant ID from the actor / request context */
export interface TenantResolver {
  /**
   * Resolve the tenant ID for this request.
   * Return undefined if the actor is system-level and should bypass isolation.
   */
  resolve(ctx: {
    actor: { type: string; id: string; groups: string[]; tenantId?: string };
    headers?: Record<string, string>;
    meta: Record<string, unknown>;
  }): string | undefined;
}

/**
 * Default tenant resolver: reads tenantId from actor.tenantId.
 * System actors (type === "system") bypass tenant isolation.
 */
export const defaultTenantResolver: TenantResolver = {
  resolve(ctx) {
    if (ctx.actor.type === "system") return undefined;
    return ctx.actor.tenantId;
  },
};

// ── Middleware ───────────────────────────────────────────────

export interface TenantIsolationMiddlewareOptions {
  /** Custom tenant resolver (defaults to reading actor.tenantId) */
  resolver?: TenantResolver;
  /** If true, reject requests where no tenantId can be resolved for non-system actors (default: true) */
  requireTenant?: boolean;
}

/**
 * Create a CommandLayer middleware registration for the "tenant" slot.
 * Sets ctx.tenantId from the resolved tenant context.
 */
export function createTenantIsolationMiddleware(
  options?: TenantIsolationMiddlewareOptions,
): MiddlewareRegistration {
  const resolver = options?.resolver ?? defaultTenantResolver;
  const requireTenant = options?.requireTenant ?? true;

  return {
    name: "tenant_isolation",
    slot: "tenant",
    order: 10,
    handler: async (ctx, next) => {
      const tenantId = resolver.resolve({
        actor: ctx.actor as { type: string; id: string; groups: string[]; tenantId?: string },
        headers: ctx.headers,
        meta: ctx.meta,
      });

      if (tenantId) {
        ctx.tenantId = tenantId;
      } else if (requireTenant && ctx.actor.type !== "system") {
        throw new AuthorizationError({
          code: "security.tenant.not_resolved",
          message: "Tenant ID could not be resolved for the current actor",
        });
      }

      await next();
    },
  };
}

// ── Tenant-aware DataProvider wrapper ────────────────────────

/**
 * Wrap a DataProvider to enforce row-level tenant isolation.
 *
 * - query() / get() / count(): injects tenantId into DataQueryOptions
 * - create(): auto-sets tenant_id on the record
 * - update() / delete(): injects tenantId into DataQueryOptions so
 *   the underlying provider scopes the WHERE clause
 *
 * Cross-tenant access is blocked: if the record's tenant_id does not
 * match, the underlying provider's tenant-scoped WHERE will return
 * not-found, effectively rejecting the operation.
 *
 * @param provider - The underlying DataProvider to wrap
 * @param tenantId - The resolved tenant ID for the current request
 */
export function createTenantAwareDataProvider(
  provider: DataProvider,
  tenantId: string,
): DataProvider {
  function withTenant(options?: DataQueryOptions): DataQueryOptions {
    return { ...options, tenantId };
  }

  return {
    async get(schema, id, options?) {
      return provider.get(schema, id, withTenant(options));
    },

    async query(schema, filter, options?) {
      return provider.query(schema, filter, withTenant(options));
    },

    async create(schema, data) {
      // Auto-set tenant_id; reject if caller tries to set a different tenant
      if (data.tenant_id !== undefined && data.tenant_id !== null && data.tenant_id !== tenantId) {
        throw new AuthorizationError({
          code: "security.tenant.cross_tenant_write",
          message: `Cannot create record with tenant_id "${data.tenant_id}" — current tenant is "${tenantId}"`,
        });
      }
      return provider.create(schema, { ...data, tenant_id: tenantId });
    },

    async update(schema, id, data, options?) {
      // Prevent changing tenant_id on update
      if (data.tenant_id !== undefined && data.tenant_id !== null && data.tenant_id !== tenantId) {
        throw new AuthorizationError({
          code: "security.tenant.cross_tenant_write",
          message: `Cannot change tenant_id to "${data.tenant_id}" — current tenant is "${tenantId}"`,
        });
      }
      return provider.update(schema, id, data, withTenant(options));
    },

    async delete(schema, id, options?) {
      return provider.delete(schema, id, withTenant(options));
    },

    async count(schema, filter?, options?) {
      return provider.count(schema, filter, withTenant(options));
    },
  };
}
