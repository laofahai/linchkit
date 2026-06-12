/**
 * API client core — auth headers, GraphQL transport, naming utilities, and action execution.
 *
 * Focused modules for entity CRUD, AI endpoints, app config, chatter,
 * execution logs, and runtime config live in dedicated files alongside this one.
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

// ── GraphQL ─────────────────────────────────────────────

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: { message: string; locations?: unknown[]; path?: string[] }[];
}

/**
 * Execute a GraphQL query or mutation.
 */
export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const res = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  handleUnauthorized(res);
  return res.json();
}

// ── GraphQL naming ──────────────────────────────────────

/** Regex for valid GraphQL names */
const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Convert a snake_case/kebab-case entity name to PascalCase for GraphQL names.
 *
 * CONSUMER side of the GraphQL naming contract: the server generates type,
 * mutation, and subscription field names (e.g. `on{Pascal}Created`) with its
 * own identical helper — addons/adapter-server/cap-adapter-server/src/graphql/naming.ts.
 * The UI must not import server code (module boundary), so this copy must
 * stay behaviorally identical: "purchase_request" → "PurchaseRequest".
 * Pinned by __tests__/subscription-naming.test.ts here and
 * __tests__/graphql-naming.test.ts on the server.
 */
export function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

// ── REST Action execution ───────────────────────────────

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  meta?: { executionId?: string };
}

/**
 * Execute a named action via REST API.
 */
export async function executeAction(
  actionName: string,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const res = await fetch(`/api/actions/${actionName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(input),
  });
  if (actionName !== "login") handleUnauthorized(res);
  return res.json();
}
