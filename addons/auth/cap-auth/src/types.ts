/**
 * AuthProvider interface — the contract that concrete auth implementations must fulfill.
 *
 * cap-auth defines the contract (schemas, action shapes, middleware shell).
 * A concrete provider (e.g. cap-auth-better-auth) implements this interface
 * to supply the actual authentication logic.
 *
 * This follows the Strategy / Provider pattern seen in:
 * - NestJS PassportStrategy (contract + pluggable strategy)
 * - better-auth's database adapter pattern
 * - Strapi's provider-registry pattern
 */

import type { ActionContext, Actor } from "@linchkit/core";
import type { z } from "zod";
import type { capAuthConfig } from "./config";

// ── Auth result types ──────────────────────────────────

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface RefreshResult {
  access_token: string;
  expires_at: string;
}

export interface CreateApiKeyResult {
  key: string;
  key_prefix: string;
}

export interface ResetPasswordResult {
  success: boolean;
}

// ── AuthProvider interface ──────────────────────────────

export interface AuthProvider {
  /**
   * Authenticate a user with email/password credentials.
   * Creates a new session and returns access + refresh tokens.
   */
  login(ctx: ActionContext, input: { email: string; password: string }): Promise<LoginResult>;

  /**
   * Invalidate a session.
   * If session_id is omitted, invalidates the current session from context.
   */
  logout(ctx: ActionContext, input: { session_id?: string }): Promise<void>;

  /**
   * Exchange a valid refresh token for a new access token.
   */
  refreshToken(ctx: ActionContext, input: { refresh_token: string }): Promise<RefreshResult>;

  /**
   * Generate a new API key for programmatic access.
   * The raw key is only returned once at creation time.
   */
  createApiKey(
    ctx: ActionContext,
    input: { name: string; scopes?: unknown; expires_at?: string },
  ): Promise<CreateApiKeyResult>;

  /**
   * Register a new user account.
   * Returns login tokens so the user is immediately authenticated.
   */
  register(
    ctx: ActionContext,
    input: { name: string; email: string; password: string },
  ): Promise<LoginResult>;

  /**
   * Request or complete a password reset.
   * Phase 1 (email only): send reset email.
   * Phase 2 (token + new_password): validate token and set new password.
   */
  resetPassword(
    ctx: ActionContext,
    input: { email?: string; token?: string; new_password?: string },
  ): Promise<ResetPasswordResult>;

  // ── Token/credential resolution (used by auth middleware) ──

  /** Resolve a JWT Bearer token to an Actor. Return null if invalid. */
  resolveToken(token: string): Promise<Actor | null>;

  /** Resolve an API key (lk_...) to an Actor. Return null if invalid. */
  resolveApiKey(key: string): Promise<Actor | null>;

  /** Resolve a session cookie value to an Actor. Return null if invalid. */
  resolveSession(sessionId: string): Promise<Actor | null>;
}

// ── Configuration for createCapAuth factory ─────────────

export interface CapAuthOptions {
  /**
   * The concrete auth provider implementation (programmatic dependency).
   * When omitted, cap-auth is returned as a pure contract (no handlers).
   * At runtime, the provider can be discovered from a registered
   * `extensions.authProvider` capability (e.g. cap-auth-better-auth).
   */
  provider?: AuthProvider;

  /**
   * Declarative configuration — validated by capAuthConfig schema at startup.
   * Keys: jwtSecret, tokenExpiry, sessionCookieName, allowAnonymous.
   */
  config?: Partial<z.infer<typeof capAuthConfig.schema>>;
}
