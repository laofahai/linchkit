/**
 * BetterAuthProvider — Concrete AuthProvider implementation using better-auth.
 *
 * Bridges @linchkit/cap-auth's AuthProvider contract with better-auth's
 * authentication engine. Uses better-auth's server-side API for session
 * management, token handling, and user registration.
 *
 * better-auth manages its own database tables (user, session, account,
 * verification) via the Drizzle adapter. These tables are separate from
 * LinchKit's cap-auth schema tables.
 */

import type {
  AuthProvider,
  CreateApiKeyResult,
  LoginResult,
  RefreshResult,
  ResetPasswordResult,
} from "@linchkit/cap-auth";
import type { ActionContext, Actor } from "@linchkit/core";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

// ── Configuration ──────────────────────────────────────

export interface BetterAuthProviderOptions {
  /**
   * Drizzle database instance (from drizzle-orm).
   * better-auth uses this via drizzleAdapter for its own tables.
   */
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db instance type varies by driver
  database: any;

  /**
   * Secret key for session token signing.
   * Defaults to JWT_SECRET env var, then falls back to "dev-secret".
   */
  secret?: string;

  /**
   * Base URL for better-auth (used for callbacks, redirects).
   * Defaults to "http://localhost:3001".
   */
  baseURL?: string;

  /**
   * Optional Drizzle schema object for better-auth tables.
   * If you've pre-generated better-auth schema via CLI, pass it here.
   */
  // biome-ignore lint/suspicious/noExplicitAny: schema type varies
  schema?: Record<string, any>;
}

// ── Crypto helpers for API keys ────────────────────────

function generateRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Helper: build Headers from session token ───────────

function headersWithSessionToken(token: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function headersWithSessionCookie(
  sessionToken: string,
  cookieName = "better-auth.session_token",
): Headers {
  const headers = new Headers();
  headers.set("cookie", `${cookieName}=${sessionToken}`);
  return headers;
}

// ── Provider implementation ─────────────────────────────

/**
 * Create a BetterAuthProvider instance backed by better-auth + Drizzle.
 *
 * Usage:
 * ```ts
 * import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'
 * import { drizzle } from 'drizzle-orm/postgres-js'
 * import postgres from 'postgres'
 *
 * const db = drizzle(postgres(process.env.DATABASE_URL!))
 * const provider = createBetterAuthProvider({ database: db })
 * ```
 */
export function createBetterAuthProvider(options: BetterAuthProviderOptions): AuthProvider {
  const secret = options.secret ?? process.env.JWT_SECRET ?? "dev-secret";
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3001";

  const auth = betterAuth({
    database: drizzleAdapter(options.database, {
      provider: "pg",
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
    },
    session: {
      // 7-day session expiry
      expiresIn: 60 * 60 * 24 * 7,
      // Auto-refresh when session is within 1 day of expiry
      updateAge: 60 * 60 * 24,
    },
  });

  // Store the auth instance for access in seed/admin functions
  (createBetterAuthProvider as BetterAuthProviderFactory).__authInstance = auth;

  return {
    async login(
      _ctx: ActionContext,
      input: { email: string; password: string },
    ): Promise<LoginResult> {
      const result = await auth.api.signInEmail({
        body: {
          email: input.email,
          password: input.password,
        },
      });

      // better-auth signInEmail returns { token, user, redirect }
      const token = result.token;

      if (!token) {
        throw new Error("Login failed: no token returned from better-auth");
      }

      // Use the token as both access and refresh token
      // (better-auth uses session tokens, not separate JWT access/refresh pairs)
      return {
        access_token: token,
        refresh_token: token,
        expires_in: 60 * 60 * 24 * 7, // 7 days (matches session config)
      };
    },

    async logout(_ctx: ActionContext, input: { session_id?: string }): Promise<void> {
      if (!input.session_id) return;

      try {
        // Revoke session by calling signOut with session token in headers
        await auth.api.signOut({
          headers: headersWithSessionCookie(input.session_id),
        });
      } catch {
        // Session may already be invalidated — ignore
      }
    },

    async refreshToken(
      _ctx: ActionContext,
      input: { refresh_token: string },
    ): Promise<RefreshResult> {
      // better-auth handles session refresh via getSession
      // Pass the session token to get a refreshed session
      try {
        const result = await auth.api.getSession({
          headers: headersWithSessionCookie(input.refresh_token),
        });

        if (!result || !result.session) {
          throw new Error("Invalid or expired refresh token");
        }

        // The session token itself acts as the access token in better-auth
        const expiresAt = new Date(result.session.expiresAt).toISOString();

        return {
          access_token: result.session.token,
          expires_at: expiresAt,
        };
      } catch {
        throw new Error("Invalid or expired refresh token");
      }
    },

    async createApiKey(
      ctx: ActionContext,
      input: { name: string; scopes?: unknown; expires_at?: string },
    ): Promise<CreateApiKeyResult> {
      // better-auth does not have built-in API key support,
      // so we implement it using LinchKit's DataProvider via ctx.
      // This stores API keys in LinchKit's api_key schema table.
      const rawKey = `lk_${generateRandomToken()}`;
      const keyPrefix = rawKey.slice(0, 11); // "lk_" + first 8 hex chars
      const keyHash = await sha256(rawKey);

      await ctx.create("api_key", {
        name: input.name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        user_id: ctx.actor.id,
        tenant_id: (ctx.actor.metadata?.tenant_id as string) ?? "default",
        scopes: input.scopes ?? [],
        expires_at: input.expires_at ?? null,
        is_active: true,
      });

      return { key: rawKey, key_prefix: keyPrefix };
    },

    async resetPassword(
      _ctx: ActionContext,
      input: { email?: string; token?: string; new_password?: string },
    ): Promise<ResetPasswordResult> {
      // Phase 1: Request password reset (send token)
      if (input.email && !input.token) {
        try {
          await auth.api.requestPasswordReset({
            body: {
              email: input.email,
              redirectTo: `${baseURL}/reset-password`,
            },
          });
        } catch {
          // Silently succeed to prevent email enumeration
        }
        return { success: true };
      }

      // Phase 2: Reset password with token
      if (input.token && input.new_password) {
        try {
          await auth.api.resetPassword({
            body: {
              newPassword: input.new_password,
              token: input.token,
            },
          });
          return { success: true };
        } catch {
          throw new Error("Invalid or expired reset token");
        }
      }

      throw new Error("Invalid reset password request: provide email or token + new_password");
    },

    // ── Token/credential resolution (used by auth middleware) ──

    async resolveToken(token: string): Promise<Actor | null> {
      try {
        const result = await auth.api.getSession({
          headers: headersWithSessionToken(token),
        });

        if (!result || !result.user) return null;

        return {
          type: "human",
          id: result.user.id,
          name: result.user.name ?? result.user.email,
          groups: [], // better-auth doesn't have built-in groups; extend via plugin or metadata
        };
      } catch {
        return null;
      }
    },

    async resolveApiKey(_key: string): Promise<Actor | null> {
      // API keys are not managed by better-auth.
      // This would need to be handled via LinchKit's DataProvider at a higher level.
      // For now, return null — the DrizzleAuthProvider in cap-auth handles this.
      return null;
    },

    async resolveSession(sessionId: string): Promise<Actor | null> {
      try {
        const result = await auth.api.getSession({
          headers: headersWithSessionCookie(sessionId),
        });

        if (!result || !result.user) return null;

        return {
          type: "human",
          id: result.user.id,
          name: result.user.name ?? result.user.email,
          groups: [],
        };
      } catch {
        return null;
      }
    },
  };
}

// ── Type for accessing the auth instance ────────────────

interface BetterAuthProviderFactory {
  (options: BetterAuthProviderOptions): AuthProvider;
  // biome-ignore lint/suspicious/noExplicitAny: Auth type varies by config
  __authInstance?: any;
}

// ── Registration / Sign-up helper ───────────────────────

/**
 * Register a new user via better-auth's signUpEmail API.
 *
 * This is exposed as a standalone function because the AuthProvider
 * interface does not include a `register` method — registration is
 * handled by the cap-auth factory action handler.
 *
 * Usage:
 * ```ts
 * const provider = createBetterAuthProvider({ database: db })
 * await registerUser({ email: 'user@example.com', password: 'pass', name: 'User' })
 * ```
 */
export async function registerUser(
  options: BetterAuthProviderOptions,
  input: { email: string; password: string; name: string },
): Promise<{ id: string; email: string; name: string }> {
  const secret = options.secret ?? process.env.JWT_SECRET ?? "dev-secret";
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3001";

  const auth = betterAuth({
    database: drizzleAdapter(options.database, {
      provider: "pg",
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    secret,
    baseURL,
    emailAndPassword: { enabled: true },
  });

  const result = await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
    },
  });

  if (!result || !result.user) {
    throw new Error("Registration failed");
  }

  return {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
  };
}

// ── System admin seeding ────────────────────────────────

export interface SeedAdminOptions {
  database: BetterAuthProviderOptions["database"];
  secret?: string;
  baseURL?: string;
  schema?: BetterAuthProviderOptions["schema"];
  email?: string;
  password?: string;
  name?: string;
}

/**
 * Seed the initial system admin user via better-auth's signUp API.
 *
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from env (or accepts explicit values).
 * If the admin user does not already exist, creates one via better-auth.
 */
export async function seedSystemAdmin(options: SeedAdminOptions): Promise<void> {
  const email = options.email ?? process.env.ADMIN_EMAIL;
  const password = options.password ?? process.env.ADMIN_PASSWORD;
  const name = options.name ?? "System Administrator";

  if (!email || !password) {
    console.log("[better-auth] No ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seeding");
    return;
  }

  const secret = options.secret ?? process.env.JWT_SECRET ?? "dev-secret";
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3001";

  const auth = betterAuth({
    database: drizzleAdapter(options.database, {
      provider: "pg",
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    secret,
    baseURL,
    emailAndPassword: { enabled: true },
  });

  // Check if admin already exists by trying to sign in
  try {
    await auth.api.signInEmail({
      body: { email, password },
    });
    console.log(`[better-auth] System admin already exists: ${email}`);
    return;
  } catch {
    // User doesn't exist or wrong password — proceed with creation
  }

  // Create admin user
  try {
    const result = await auth.api.signUpEmail({
      body: { email, password, name },
    });

    if (result?.user) {
      console.log(`[better-auth] System admin created: ${email}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If user already exists with different password, that's OK
    if (msg.includes("already") || msg.includes("exists")) {
      console.log(`[better-auth] System admin already exists: ${email}`);
    } else {
      console.error(`[better-auth] Failed to create system admin: ${msg}`);
    }
  }
}
