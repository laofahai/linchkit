/**
 * API client foundations: auth helpers.
 *
 * Domain-specific clients live in focused sibling modules:
 *   entity-api.ts     — Entity CRUD, list/query, state transitions
 *   entity-meta.ts    — Entity metadata, relations, onchange (Spec 64)
 *   action-api.ts     — REST action execution
 *   ai-api.ts         — AI endpoints (auto-fill, search, intent resolution)
 *   chatter-api.ts    — Chatter timeline
 *   execution-log-api.ts — Execution logs, state transition history
 *   config-api.ts     — Runtime config + ConfigStore KV (Spec 42)
 *   graphql.ts        — Low-level GraphQL fetch helper
 *   app-config.ts     — App config cache (fetchAppConfig, isAuthEnabled, …)
 */

import { isAuthEnabled } from "./app-config";
import { getDevRoleHeaders } from "./dev-role";
import { getTenantHeaders } from "./tenant";

// ── Auth header helper ──────────────────────────────────

export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  const tenantHeaders = getTenantHeaders();
  // Dev-only role switching: empty unless an explicit choice was stored,
  // and ignored by servers with a real auth resolver.
  const devRoleHeaders = getDevRoleHeaders();
  if (token) {
    return { Authorization: `Bearer ${token}`, ...tenantHeaders, ...devRoleHeaders };
  }
  return { ...tenantHeaders, ...devRoleHeaders };
}

export function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    localStorage.removeItem("linchkit:token");
    localStorage.removeItem("linchkit:authenticated");
    // Only redirect to login if auth capability is loaded
    if (isAuthEnabled()) {
      window.location.href = "/login";
    }
  }
}

// ── Backward-compat re-exports ──────────────────────────
// External consumers (cap-audit-ui, cap-search-ui) import graphql from
// this module path; re-export so they don't need a coordinated update.
export type { GraphQLResponse } from "./graphql";
export { graphql, throwOnErrors } from "./graphql";
