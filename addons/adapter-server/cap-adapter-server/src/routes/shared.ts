/**
 * Shared utilities for route modules.
 *
 * Contains error-status mapping, actor resolution, locale parsing,
 * and other helpers used across multiple route files.
 */

import type { Actor, CapabilityDefinition } from "@linchkit/core";

/** Default anonymous actor for unauthenticated requests. */
export const ANONYMOUS_ACTOR: Actor = {
  type: "system",
  id: "anonymous",
  groups: [],
};

/**
 * Elevated anonymous actor for no-auth mode.
 * When auth is not enabled, the anonymous actor gets admin privileges
 * so all actions (including permission-gated ones) can be executed
 * during development and demo scenarios.
 */
export const NO_AUTH_ACTOR: Actor = {
  type: "human",
  id: "anonymous",
  groups: ["admin", "manager", "user"],
};

/**
 * Map structured error codes to HTTP status codes.
 * Preferred over message-text matching when a code is available.
 */
const ERROR_CODE_STATUS: Record<string, number> = {
  auth: 401,
  "auth.required": 401,
  "auth.credentials.required": 401,
  "auth.token.invalid": 401,
  "auth.token.expired": 401,
  "auth.api_key.invalid": 401,
  "auth.session.invalid": 401,
  authz: 403,
  "authz.action.denied": 403,
  "authz.group_required": 403,
  "exposure.blocked": 403,
  validation: 400,
  "validation.failed": 400,
  "validation.input": 400,
  not_found: 404,
  "not_found.action": 404,
  "not_found.record": 404,
  conflict: 409,
  "conflict.state": 409,
  "conflict.version": 409,
  "rate_limit.exceeded": 429,
  business: 422,
};

/**
 * Map an error code string to HTTP status, supporting both exact and
 * prefix matches (e.g. "PERMISSION.DENIED.FOO" matches "PERMISSION.DENIED").
 */
function mapErrorCodeToStatus(code: string): number | undefined {
  // Exact match first
  if (code in ERROR_CODE_STATUS) return ERROR_CODE_STATUS[code];
  // Prefix match — walk from most specific to least
  const parts = code.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".");
    if (prefix in ERROR_CODE_STATUS) return ERROR_CODE_STATUS[prefix];
  }
  return undefined;
}

/**
 * Determine HTTP status code from action result.
 * Checks structured error code first, falls back to message-text matching.
 */
export function resolveStatusCode(result: { success: boolean; data?: unknown }): number {
  if (result.success) return 200;

  const errData = result.data as Record<string, unknown> | undefined;

  // Prefer structured error code when available (e.g. from PipelineError)
  const errorCode = typeof errData?.code === "string" ? errData.code : undefined;
  if (errorCode) {
    const codeStatus = mapErrorCodeToStatus(errorCode);
    if (codeStatus !== undefined) return codeStatus;
  }

  // Fallback: match on error message text
  const errorMsg = (errData?.error as string) ?? "";

  // Not found patterns
  if (errorMsg.includes("not found")) return 404;
  // Permission denied patterns
  if (errorMsg.includes("not allowed") || errorMsg.includes("does not belong to")) return 403;
  // Exposure blocked
  if (errorMsg.includes("not exposed")) return 403;
  // Validation failures
  if (errorMsg.includes("validation failed") || errorMsg.includes("Validation failed")) return 400;
  // State transition conflicts and version conflicts
  if (errorMsg.includes("State transition") || errorMsg.includes("State machine")) return 409;
  if (errorMsg.includes("Version conflict")) return 409;

  // Default: 422 for business logic failures
  return 422;
}

/**
 * Parse the primary locale from an Accept-Language header value.
 * Takes the first locale before ',' or ';', normalizing whitespace.
 * Returns undefined if the header is missing or empty.
 */
export function parseAcceptLanguage(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  // Take the first language tag before ',' or ';'
  const first = header.split(/[,;]/)[0]?.trim();
  return first || undefined;
}

/**
 * Resolve locale from a request: ?locale= query param takes priority over Accept-Language header.
 */
export function resolveRequestLocale(request: Request): string | undefined {
  const url = new URL(request.url);
  const queryLocale = url.searchParams.get("locale");
  if (queryLocale) return queryLocale;
  return parseAcceptLanguage(request.headers.get("accept-language"));
}

// ── Error response helpers ───────────────────────────────────────────

/** Return a 503 (or custom status) "service unavailable" error envelope. */
export function serviceUnavailable(
  set: { status?: number | string | undefined },
  message: string,
  status = 503,
) {
  set.status = status;
  return { success: false as const, error: { message } };
}

/** Return a 404 "not found" error envelope. */
export function notFound(set: { status?: number | string | undefined }, message: string) {
  set.status = 404;
  return { success: false as const, error: { message } };
}

/** Return a 400 "bad request" error envelope. */
export function badRequest(set: { status?: number | string | undefined }, message: string) {
  set.status = 400;
  return { success: false as const, error: { message } };
}

/** Return a 500 "server error" error envelope. */
export function serverError(set: { status?: number | string | undefined }, message: string) {
  set.status = 500;
  return { success: false as const, error: { message } };
}

// ── Collection helper ────────────────────────────────────────────────

/**
 * Collect items from direct options or, when empty, aggregate from capabilities.
 * Replaces the repeated "allFlows/allStates" collection pattern.
 */
export function collectFromCapabilities<T>(
  direct: T[] | undefined,
  capabilities: CapabilityDefinition[],
  field: keyof CapabilityDefinition,
): T[] {
  const items: T[] = [...(direct ?? [])];
  if (!items.length && capabilities.length > 0) {
    for (const cap of capabilities) {
      const capItems = cap[field] as T[] | undefined;
      if (capItems) items.push(...capItems);
    }
  }
  return items;
}

/**
 * Resolve the authenticated actor from a request.
 * When no auth resolver is configured (no-auth mode), returns an elevated
 * actor with admin/manager/user groups so permission-gated actions work
 * in development and demo scenarios.
 * When an auth resolver is configured but returns undefined, falls back to
 * the restricted anonymous actor (no groups).
 */
export async function resolveActor(
  request: Request,
  resolveRequestActor?: (request: Request) => Promise<Actor | undefined> | Actor | undefined,
): Promise<Actor> {
  if (!resolveRequestActor) return NO_AUTH_ACTOR;
  return (await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR;
}
