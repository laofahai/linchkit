/**
 * Authentication middleware — fills the Command Layer "auth" slot
 *
 * Three-channel resolution pattern (spec 10a_authentication.md §2.1):
 * 1. Authorization: Bearer lk_... → API Key channel
 * 2. Authorization: Bearer eyJ... → JWT channel
 * 3. Cookie: session_id=... → Session Cookie channel
 *
 * ALL credentials go through the Authorization: Bearer header, differentiated
 * by prefix. Session cookies are a fallback for browser clients.
 *
 * Resolution order: Bearer (API key or JWT) → Session cookie → anonymous
 * On success, populates ctx.actor with resolved user identity.
 */

import type {
  Actor,
  CommandContext,
  MiddlewareHandler,
  MiddlewareRegistration,
} from "@linchkit/core";
import { AuthenticationError } from "@linchkit/core";

// ── Types ─────────────────────────────────────────────────

export interface AuthResolverOptions {
  /** Resolve a JWT Bearer token to an Actor. Return null if invalid. */
  resolveToken: (token: string) => Promise<Actor | null>;
  /** Resolve an API key (lk_...) to an Actor. Return null if invalid. */
  resolveApiKey: (key: string) => Promise<Actor | null>;
  /** Resolve a session cookie value to an Actor. Return null if invalid. */
  resolveSession: (sessionId: string) => Promise<Actor | null>;
  /** Cookie name for session-based auth (default: "lk_session") */
  sessionCookieName?: string;
  /** If true, anonymous requests are allowed through (default: true) */
  allowAnonymous?: boolean;
}

// ── Constants ─────────────────────────────────────────────

const BEARER_PREFIX = "Bearer ";
const API_KEY_TOKEN_PREFIX = "lk_";
const DEFAULT_SESSION_COOKIE = "lk_session";

// ── Token extraction helpers ──────────────────────────────

/** Extract Bearer token from Authorization header */
function extractBearerToken(headers: Record<string, string> | undefined): string | null {
  const auth = headers?.authorization ?? headers?.Authorization;
  if (auth?.startsWith(BEARER_PREFIX)) {
    return auth.slice(BEARER_PREFIX.length).trim();
  }
  return null;
}

/** Extract session ID from cookie header */
function extractSessionCookie(
  headers: Record<string, string> | undefined,
  cookieName: string,
): string | null {
  const cookieHeader = headers?.cookie ?? headers?.Cookie;
  if (!cookieHeader) return null;

  // Simple cookie parser: split on "; " and find the matching name
  const cookies = cookieHeader.split("; ");
  for (const cookie of cookies) {
    const eqIndex = cookie.indexOf("=");
    if (eqIndex === -1) continue;
    const name = cookie.slice(0, eqIndex).trim();
    if (name === cookieName) {
      return cookie.slice(eqIndex + 1).trim();
    }
  }
  return null;
}

// ── Middleware factory ─────────────────────────────────────

/**
 * Create the auth middleware handler.
 *
 * Usage:
 * ```ts
 * const authHandler = createAuthMiddleware({
 *   resolveToken: async (token) => { ... },
 *   resolveApiKey: async (key) => { ... },
 *   resolveSession: async (sid) => { ... },
 * });
 * ```
 */
export function createAuthMiddleware(options: AuthResolverOptions): MiddlewareHandler {
  const {
    resolveToken,
    resolveApiKey,
    resolveSession,
    sessionCookieName = DEFAULT_SESSION_COOKIE,
    allowAnonymous = true,
  } = options;

  return async (ctx: CommandContext, next: () => Promise<void>): Promise<void> => {
    let actor: Actor | null = null;

    // Channel 1 & 2: Bearer token — differentiated by prefix
    const bearerToken = extractBearerToken(ctx.headers);
    if (bearerToken) {
      if (bearerToken.startsWith(API_KEY_TOKEN_PREFIX)) {
        // API Key channel: Bearer lk_...
        actor = await resolveApiKey(bearerToken);
        if (!actor) {
          throw new AuthenticationError({
            code: "auth.api_key.invalid",
            message: "Invalid or revoked API key",
          });
        }
        ctx.actor = actor;
        ctx.meta.authMethod = "api_key";
      } else {
        // JWT channel: Bearer eyJ... (or any non-lk_ token)
        actor = await resolveToken(bearerToken);
        if (!actor) {
          throw new AuthenticationError({
            code: "auth.token.invalid",
            message: "Invalid or expired Bearer token",
          });
        }
        ctx.actor = actor;
        ctx.meta.authMethod = "bearer";
      }
      await next();
      return;
    }

    // Channel 3: Session cookie
    const sessionId = extractSessionCookie(ctx.headers, sessionCookieName);
    if (sessionId) {
      actor = await resolveSession(sessionId);
      if (!actor) {
        throw new AuthenticationError({
          code: "auth.session.invalid",
          message: "Invalid or expired session",
        });
      }
      ctx.actor = actor;
      ctx.meta.authMethod = "session";
      await next();
      return;
    }

    // No credentials provided — allow anonymous or reject
    if (!allowAnonymous) {
      throw new AuthenticationError({
        code: "auth.credentials.required",
        message: "Authentication required",
      });
    }

    // ctx.actor stays as the default anonymous actor set by CommandLayer
    ctx.meta.authMethod = "anonymous";
    await next();
  };
}

// ── Middleware registration helper ────────────────────────

/**
 * Create a MiddlewareRegistration for the auth slot.
 */
export function createAuthMiddlewareRegistration(
  options: AuthResolverOptions,
): MiddlewareRegistration {
  return {
    name: "cap-auth",
    slot: "auth",
    order: 50,
    handler: createAuthMiddleware(options),
  };
}
