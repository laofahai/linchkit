/**
 * BetterAuthProvider — Concrete AuthProvider implementation using better-auth.
 *
 * Bridges @linchkit/cap-auth's AuthProvider contract with better-auth's
 * authentication engine. Uses better-auth's server-side API for session
 * management, token handling, and user registration.
 *
 * Plugins enabled:
 * - bearer: Allows session resolution via Authorization: Bearer header
 * - admin: Provides role management for user groups (e.g., system_admin)
 * - username: Allows login via username (used for phone number login)
 * - phoneNumber: Enables phone + OTP authentication flow
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
import type { ActionContext, Actor, DataProvider } from "@linchkit/core";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { username } from "better-auth/plugins/username";
import { sql } from "drizzle-orm";

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
   * Defaults to JWT_SECRET env var. In production (NODE_ENV/BUN_ENV=production),
   * JWT_SECRET is required or an error is thrown. In dev, falls back to "dev-secret".
   */
  secret?: string;

  /**
   * Base URL for better-auth (used for callbacks, redirects).
   * Defaults to AUTH_BASE_URL or BETTER_AUTH_URL env var, then "http://localhost:3001".
   */
  baseURL?: string;

  /**
   * Optional Drizzle schema object for better-auth tables.
   * If you've pre-generated better-auth schema via CLI, pass it here.
   */
  // biome-ignore lint/suspicious/noExplicitAny: schema type varies
  schema?: Record<string, any>;

  /**
   * SMS gateway callback for phone OTP login.
   * If not provided, OTP codes are logged to console (dev mode).
   */
  sendOTP?: (data: { phoneNumber: string; code: string }) => Promise<void>;

  /**
   * Default country code prepended to phone numbers without a '+' prefix.
   * E.g., "+86" for China. If not set, bare numbers are used as-is.
   */
  defaultCountryCode?: string;

  /**
   * Optional DataProvider for API key resolution.
   * When provided, resolveApiKey() can query the "api_key" schema
   * to verify keys by prefix + hash lookup.
   */
  dataProvider?: DataProvider;
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

function headersWithBearerToken(token: string): Headers {
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

// ── Extract groups from better-auth user ────────────────

/**
 * Map better-auth user role to LinchKit groups array.
 * The admin plugin adds a `role` field (default "user").
 */
// biome-ignore lint/suspicious/noExplicitAny: better-auth user type varies by plugins
function extractGroups(user: any): string[] {
  // admin plugin role field
  const role = user?.role as string | undefined;
  if (role === "admin") return ["system_admin"];
  if (role && role !== "user") return [role];
  return ["user"];
}

// ── Phone number helpers ─────────────────────────────────

/**
 * Normalize a phone number by stripping non-digit characters (preserving leading +).
 * Optionally prepends a default country code when no '+' prefix is present.
 */
function normalizePhone(input: string, defaultCountryCode?: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  if (input.startsWith("+")) return digits;
  // Prepend default country code for bare local numbers
  if (defaultCountryCode) {
    const code = defaultCountryCode.startsWith("+") ? defaultCountryCode : `+${defaultCountryCode}`;
    return `${code}${digits.replace(/^\+/, "")}`;
  }
  return digits.replace(/^\+/, "");
}

/**
 * Check if a string looks like a phone number (7-15 digits, optional + prefix).
 * Normalizes the input before testing.
 */
function isPhoneNumber(value: string): boolean {
  return /^\+?\d{7,15}$/.test(normalizePhone(value));
}

/**
 * Generate a placeholder email for phone-only registrations.
 * Uses a `.phone.local` domain so it is clearly synthetic.
 */
function phonePlaceholderEmail(phone: string): string {
  const sanitized = normalizePhone(phone).replace(/[^0-9]/g, "");
  return `${sanitized}@phone.local`;
}

/**
 * Check if an email is a phone placeholder (synthetic @phone.local address).
 */
function isPhonePlaceholderEmail(email: string): boolean {
  return email.endsWith("@phone.local");
}

// ── Create auth instance helper ─────────────────────────

function resolveSecret(explicit?: string): string {
  if (explicit) return explicit;
  const envSecret = process.env.JWT_SECRET;
  if (envSecret) return envSecret;

  const isProduction =
    process.env.NODE_ENV === "production" || process.env.BUN_ENV === "production";
  if (isProduction) {
    throw new Error("JWT_SECRET environment variable is required in production");
  }

  console.warn("[linch] WARNING: Using default dev secret. Set JWT_SECRET in production.");
  return "dev-secret";
}

function createAuthInstance(options: BetterAuthProviderOptions) {
  const secret = resolveSecret(options.secret);
  const baseURL =
    options.baseURL ??
    process.env.AUTH_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001";

  const sendOTPHandler =
    options.sendOTP ??
    (async ({ phoneNumber: phone, code }: { phoneNumber: string; code: string }) => {
      console.log(`[better-auth] OTP for ${phone}: ${code} (configure SMS gateway for production)`);
    });

  return betterAuth({
    database: drizzleAdapter(options.database, {
      provider: "pg",
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      bearer(),
      admin(),
      username({
        usernameValidator: (u) => /^[\w\d+\-@.]+$/.test(u),
        minUsernameLength: 3,
        maxUsernameLength: 30,
      }),
      phoneNumber({
        sendOTP: sendOTPHandler,
      }),
    ],
    session: {
      // 7-day session expiry
      expiresIn: 60 * 60 * 24 * 7,
      // Auto-refresh when session is within 1 day of expiry
      updateAge: 60 * 60 * 24,
    },
  });
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
  const auth = createAuthInstance(options);

  return {
    async login(
      _ctx: ActionContext,
      input: { email: string; password: string },
    ): Promise<LoginResult> {
      let token: string | undefined;

      if (isPhoneNumber(input.email)) {
        // Phone number detected — normalize and sign in via username plugin
        const phone = normalizePhone(input.email, options.defaultCountryCode);
        const result = await auth.api.signInUsername({
          body: {
            username: phone,
            password: input.password,
          },
        });
        token = result.token;
      } else {
        // Default: email login
        const result = await auth.api.signInEmail({
          body: {
            email: input.email,
            password: input.password,
          },
        });
        token = result.token;
      }

      if (!token) {
        throw new Error("Login failed: no token returned from better-auth");
      }

      return {
        access_token: token,
        refresh_token: token,
        expires_in: 60 * 60 * 24 * 7,
      };
    },

    async register(
      _ctx: ActionContext,
      input: { name: string; email: string; password: string },
    ): Promise<LoginResult> {
      const isPhone = isPhoneNumber(input.email);
      const phone = isPhone ? normalizePhone(input.email, options.defaultCountryCode) : undefined;
      const email = phone ? phonePlaceholderEmail(phone) : input.email;

      const result = await auth.api.signUpEmail({
        body: {
          email,
          password: input.password,
          name: input.name,
          // When registering with a phone number, store it as the username
          // so they can log in via signInUsername later.
          ...(phone ? { username: phone } : {}),
        },
      });

      if (!result?.token) {
        throw new Error("Registration failed: no token returned from better-auth");
      }

      return {
        access_token: result.token,
        refresh_token: result.token,
        expires_in: 60 * 60 * 24 * 7,
      };
    },

    async logout(_ctx: ActionContext, input: { session_id?: string }): Promise<void> {
      // Try to revoke via session_id (cookie) or bearer token from context
      const token = input.session_id;
      if (!token) {
        // No session info available — client-side cleanup only
        return;
      }

      try {
        await auth.api.signOut({
          headers: headersWithBearerToken(token),
        });
      } catch {
        // Session may already be invalidated — ignore
      }
    },

    async refreshToken(
      _ctx: ActionContext,
      input: { refresh_token: string },
    ): Promise<RefreshResult> {
      try {
        const result = await auth.api.getSession({
          headers: headersWithBearerToken(input.refresh_token),
        });

        if (!result?.session) {
          throw new Error("Invalid or expired refresh token");
        }

        return {
          access_token: result.session.token,
          expires_at: new Date(result.session.expiresAt).toISOString(),
        };
      } catch {
        throw new Error("Invalid or expired refresh token");
      }
    },

    async createApiKey(
      ctx: ActionContext,
      input: { name: string; scopes?: unknown; expires_at?: string },
    ): Promise<CreateApiKeyResult> {
      const rawKey = `lk_${generateRandomToken()}`;
      const keyPrefix = rawKey.slice(0, 11);
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
      const baseURL =
        options.baseURL ??
        process.env.AUTH_BASE_URL ??
        process.env.BETTER_AUTH_URL ??
        "http://localhost:3001";

      if (input.email && !input.token) {
        // Phone-based accounts use @phone.local placeholder — email reset won't work
        if (isPhonePlaceholderEmail(input.email)) {
          throw new Error(
            "Password reset via email is not available for phone-based accounts. Use OTP-based reset instead.",
          );
        }

        try {
          await auth.api.requestPasswordReset({
            body: { email: input.email, redirectTo: `${baseURL}/reset-password` },
          });
        } catch {
          // Silently succeed to prevent email enumeration
        }
        return { success: true };
      }

      if (input.token && input.new_password) {
        try {
          await auth.api.resetPassword({
            body: { newPassword: input.new_password, token: input.token },
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
          headers: headersWithBearerToken(token),
        });

        if (!result?.user) return null;

        return {
          type: "human",
          id: result.user.id,
          name: result.user.name ?? result.user.email,
          groups: extractGroups(result.user),
        };
      } catch {
        // Token verification or session lookup failed — treat as unauthenticated
        return null;
      }
    },

    async resolveApiKey(key: string): Promise<Actor | null> {
      if (!key.startsWith("lk_")) return null;
      if (!options.dataProvider) return null;

      const keyHash = await sha256(key);
      const keyPrefix = key.slice(0, 11);

      const results = await options.dataProvider.query("api_key", {
        key_prefix: keyPrefix,
        is_active: true,
      });

      const apiKey = results.find((k) => k.key_hash === keyHash);
      if (!apiKey) return null;

      // Check expiry
      if (apiKey.expires_at && new Date(apiKey.expires_at as string) < new Date()) return null;

      return {
        type: "external",
        id: apiKey.user_id as string,
        name: `API Key: ${apiKey.name as string}`,
        groups: [],
      };
    },

    async resolveSession(sessionId: string): Promise<Actor | null> {
      try {
        const result = await auth.api.getSession({
          headers: headersWithSessionCookie(sessionId),
        });

        if (!result?.user) return null;

        return {
          type: "human",
          id: result.user.id,
          name: result.user.name ?? result.user.email,
          groups: extractGroups(result.user),
        };
      } catch {
        // Session lookup failed or expired — treat as unresolvable
        return null;
      }
    },
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
 * Creates the user and assigns the "admin" role via the admin plugin.
 */
export async function seedSystemAdmin(options: SeedAdminOptions): Promise<void> {
  const email = options.email ?? process.env.ADMIN_EMAIL;
  const password = options.password ?? process.env.ADMIN_PASSWORD;
  const name = options.name ?? "System Administrator";

  if (!email || !password) {
    console.log("[better-auth] No ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seeding");
    return;
  }

  const auth = createAuthInstance({
    database: options.database,
    secret: options.secret,
    baseURL: options.baseURL,
    schema: options.schema,
  });

  // Check if admin already exists by trying to sign in
  try {
    await auth.api.signInEmail({ body: { email, password } });
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
      // Direct DB update since admin API requires an existing admin session
      try {
        await options.database.execute(
          sql`UPDATE "user" SET "role" = 'admin' WHERE "id" = ${result.user.id}`,
        );
        console.log(`[better-auth] System admin created with admin role: ${email}`);
      } catch {
        console.warn(`[better-auth] Admin created but failed to set role: ${email}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already") || msg.includes("exists")) {
      console.log(`[better-auth] System admin already exists: ${email}`);
    } else {
      console.error(`[better-auth] Failed to create system admin: ${msg}`);
    }
  }
}
