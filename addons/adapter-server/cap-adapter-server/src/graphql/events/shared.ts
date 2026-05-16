/**
 * Shared helpers for the event-replay GraphQL resolvers.
 *
 * Permission gate
 * ───────────────
 * `requireAdmin` is the lowest-friction admin check that still rejects the
 * default anonymous actor wired by CommandLayer (`{ type: "system", id:
 * "anonymous", groups: [] }`). It allows any actor that:
 *   - is not the anonymous fallback AND
 *   - either has the `"admin"` group OR is a system/worker process.
 *
 * This is intentionally simple — proper admin gating belongs in
 * cap-permission. Once that capability is wired into the GraphQL transport
 * via a permission slot middleware, this resolver-local check can be
 * dropped. Tracked as a follow-up.
 *
 * Date parsing
 * ────────────
 * `parseIsoDate` rejects strings that fail to produce a finite
 * `Date.getTime()`. The service layer already silently drops invalid
 * dates from the SQL filter, but failing fast at the boundary keeps the
 * caller honest about what window was actually applied.
 */

import { GraphQLError } from "graphql";

interface ActorLike {
  id?: string;
  type?: string;
  groups?: string[];
}

const ADMIN_GROUP = "admin";
const ANONYMOUS_ID = "anonymous";
const TRUSTED_ACTOR_TYPES: ReadonlySet<string> = new Set(["system", "worker"]);

/**
 * Throw a Forbidden GraphQL error when the actor cannot run an admin-only
 * operation. Accepts the actor in its loosest shape so the helper composes
 * with multiple resolver context types.
 */
export function requireAdmin(actor?: ActorLike | null): void {
  if (!actor || typeof actor !== "object") {
    throw new GraphQLError("Forbidden: events surface requires an authenticated actor.", {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  }
  if (!actor.id || actor.id === ANONYMOUS_ID) {
    throw new GraphQLError("Forbidden: events surface requires an authenticated actor.", {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  }
  const groups = Array.isArray(actor.groups) ? actor.groups : [];
  const hasAdminGroup = groups.includes(ADMIN_GROUP);
  const isTrustedType = typeof actor.type === "string" && TRUSTED_ACTOR_TYPES.has(actor.type);
  if (!hasAdminGroup && !isTrustedType) {
    throw new GraphQLError("Forbidden: events surface is admin-only.", {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  }
}

/**
 * Parse an ISO 8601 string into a `Date`. Returns `undefined` for empty input.
 * Throws when the input is a non-empty string that does not parse to a finite
 * date — the SQL layer ignores invalid dates silently and we want to fail loud.
 */
export function parseIsoDate(value: string | undefined): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid ISO 8601 timestamp: ${value}`);
  }
  return dt;
}

/**
 * Post-filter helper: return true when the row's `tenantId` is visible to the
 * caller's tenant scope. The service's `get`/`fetchRow` does NOT filter by
 * tenant, so resolvers calling those paths must apply this guard.
 *
 * Rules:
 *   - When `ctxTenantId` is undefined, the caller is acting in the
 *     untenanted (global) scope and may see ALL rows.
 *   - When `ctxTenantId` is set, the row must either match or be unscoped
 *     (`tenantId === undefined`) — unscoped rows are framework-emitted
 *     events the operator should still see.
 */
export function isVisibleToTenant(
  rowTenantId: string | undefined,
  ctxTenantId: string | undefined,
): boolean {
  if (ctxTenantId === undefined) return true;
  if (rowTenantId === undefined) return true;
  return rowTenantId === ctxTenantId;
}
