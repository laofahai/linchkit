/**
 * BetterAuthProvider — Concrete AuthProvider implementation using better-auth.
 *
 * This package bridges @linchkit/cap-auth's contract with better-auth's
 * authentication engine. It implements the AuthProvider interface by
 * delegating to better-auth's API for session management, token handling,
 * OAuth flows, and API key operations.
 *
 * Status: Skeleton — actual better-auth integration will be implemented in M1.
 */

import type {
  AuthProvider,
  CreateApiKeyResult,
  LoginResult,
  RefreshResult,
  ResetPasswordResult,
} from "@linchkit/cap-auth";
import type { ActionContext, Actor } from "@linchkit/core";

// ── Configuration ──────────────────────────────────────

export interface BetterAuthProviderOptions {
  /**
   * better-auth instance or configuration.
   * In M1, this will accept a betterAuth() instance.
   */
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance type will be refined in M1
  auth?: any;

  /**
   * Database adapter for better-auth.
   * In M1, this will accept a Drizzle adapter.
   */
  // biome-ignore lint/suspicious/noExplicitAny: database adapter type will be refined in M1
  database?: any;
}

// ── Provider implementation ─────────────────────────────

/**
 * Create a BetterAuthProvider instance.
 *
 * Usage (M1):
 * ```ts
 * import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'
 * import { betterAuth } from 'better-auth'
 * import { drizzleAdapter } from 'better-auth/adapters/drizzle'
 *
 * const provider = createBetterAuthProvider({
 *   auth: betterAuth({ database: drizzleAdapter(db) }),
 * })
 * ```
 */
export function createBetterAuthProvider(_options?: BetterAuthProviderOptions): AuthProvider {
  // TODO (M1): Wire to actual better-auth instance
  // const auth = options?.auth ?? betterAuth({ database: options?.database })

  return {
    async login(
      _ctx: ActionContext,
      _input: { email: string; password: string },
    ): Promise<LoginResult> {
      // M1: auth.api.signInEmail({ body: { email, password } })
      throw new Error(
        "BetterAuthProvider.login: Not yet implemented. Requires better-auth integration (M1).",
      );
    },

    async logout(_ctx: ActionContext, _input: { session_id?: string }): Promise<void> {
      // M1: auth.api.signOut({ headers })
      throw new Error(
        "BetterAuthProvider.logout: Not yet implemented. Requires better-auth integration (M1).",
      );
    },

    async refreshToken(
      _ctx: ActionContext,
      _input: { refresh_token: string },
    ): Promise<RefreshResult> {
      // M1: auth.api.refreshToken({ body: { refreshToken } })
      throw new Error(
        "BetterAuthProvider.refreshToken: Not yet implemented. Requires better-auth integration (M1).",
      );
    },

    async createApiKey(
      _ctx: ActionContext,
      _input: { name: string; scopes?: unknown; expires_at?: string },
    ): Promise<CreateApiKeyResult> {
      // M1: Custom API key generation using crypto.getRandomValues
      throw new Error(
        "BetterAuthProvider.createApiKey: Not yet implemented. Requires better-auth integration (M1).",
      );
    },

    async resetPassword(
      _ctx: ActionContext,
      _input: { email?: string; token?: string; new_password?: string },
    ): Promise<ResetPasswordResult> {
      // M1: auth.api.forgetPassword / auth.api.resetPassword
      throw new Error(
        "BetterAuthProvider.resetPassword: Not yet implemented. Requires better-auth integration (M1).",
      );
    },

    async resolveToken(_token: string): Promise<Actor | null> {
      // M1: auth.api.getSession({ headers: { authorization: `Bearer ${token}` } })
      // Convert better-auth session to Actor
      return null;
    },

    async resolveApiKey(_key: string): Promise<Actor | null> {
      // M1: Hash key → lookup in api_key table → resolve to Actor
      return null;
    },

    async resolveSession(_sessionId: string): Promise<Actor | null> {
      // M1: auth.api.getSession({ headers: { cookie: `session=${sessionId}` } })
      // Convert better-auth session to Actor
      return null;
    },
  };
}
