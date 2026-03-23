/**
 * DrizzleAuthProvider — Production-ready auth provider using Drizzle + PostgreSQL.
 *
 * Uses the DataProvider abstraction for CRUD operations, Bun.password for hashing,
 * and jose for JWT signing/verification.
 */

import type { ActionContext, Actor, DataProvider } from "@linchkit/core";
import { jwtVerify, SignJWT } from "jose";
import type {
  AuthProvider,
  CreateApiKeyResult,
  LoginResult,
  RefreshResult,
  ResetPasswordResult,
} from "../types";

// ── Configuration ────────────────────────────────────────────

export interface DrizzleAuthProviderOptions {
  dataProvider: DataProvider;
  jwtSecret: string;
  /** Access token lifetime in seconds (default: 3600 = 1 hour) */
  accessTokenTTL?: number;
  /** Refresh token lifetime in seconds (default: 604800 = 7 days) */
  refreshTokenTTL?: number;
}

// ── JWT helpers ──────────────────────────────────────────────

interface JWTPayload {
  sub: string;
  email: string;
  groups: string[];
  type: "access" | "refresh";
  sid?: string; // session id
}

// ── Crypto helpers ───────────────────────────────────────────

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

// ── DrizzleAuthProvider ──────────────────────────────────────

class DrizzleAuthProvider implements AuthProvider {
  private readonly dp: DataProvider;
  private readonly secret: Uint8Array;
  private readonly accessTTL: number;
  private readonly refreshTTL: number;

  constructor(options: DrizzleAuthProviderOptions) {
    this.dp = options.dataProvider;
    this.secret = new TextEncoder().encode(options.jwtSecret);
    this.accessTTL = options.accessTokenTTL ?? 3600;
    this.refreshTTL = options.refreshTokenTTL ?? 86400 * 7;
  }

  // ── JWT helpers ──────────────────────────────────────────

  private async signToken(payload: JWTPayload, ttlSeconds: number): Promise<string> {
    return new SignJWT(payload as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setIssuer("linchkit")
      .sign(this.secret);
  }

  private async verifyToken(token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: "linchkit" });
      return payload as unknown as JWTPayload;
    } catch {
      return null;
    }
  }

  // ── AuthProvider methods ─────────────────────────────────

  async login(
    _ctx: ActionContext,
    input: { email: string; password: string },
  ): Promise<LoginResult> {
    // Find user by email
    const users = await this.dp.query("user", { email: input.email, limit: 1 });
    const user = users[0];
    if (!user) {
      throw new Error("Invalid email or password");
    }

    // Verify password
    const passwordHash = user.password_hash as string | undefined;
    if (!passwordHash) {
      throw new Error("Invalid email or password");
    }
    const valid = await Bun.password.verify(input.password, passwordHash);
    if (!valid) {
      throw new Error("Invalid email or password");
    }

    const userId = user.id as string;
    const userEmail = user.email as string;
    const groups = (user.groups as string[]) ?? [];

    // Create session
    const sessionToken = generateRandomToken();
    const sessionHash = await sha256(sessionToken);
    const sessionExpiresAt = new Date(Date.now() + this.refreshTTL * 1000).toISOString();

    const session = await this.dp.create("session", {
      user_id: userId,
      token_hash: sessionHash,
      expires_at: sessionExpiresAt,
      is_active: true,
    });
    const sessionId = session.id as string;

    // Sign JWT tokens
    const accessToken = await this.signToken(
      { sub: userId, email: userEmail, groups, type: "access", sid: sessionId },
      this.accessTTL,
    );
    const refreshToken = await this.signToken(
      { sub: userId, email: userEmail, groups, type: "refresh", sid: sessionId },
      this.refreshTTL,
    );

    // Update last_login_at
    await this.dp.update("user", userId, { last_login_at: new Date().toISOString() });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.accessTTL,
    };
  }

  async logout(_ctx: ActionContext, input: { session_id?: string }): Promise<void> {
    if (!input.session_id) return;

    try {
      await this.dp.update("session", input.session_id, { is_active: false });
    } catch {
      // Session may already be deleted or not found — ignore
    }
  }

  async refreshToken(
    _ctx: ActionContext,
    input: { refresh_token: string },
  ): Promise<RefreshResult> {
    const payload = await this.verifyToken(input.refresh_token);
    if (!payload || payload.type !== "refresh") {
      throw new Error("Invalid or expired refresh token");
    }

    // Verify session is still active
    if (payload.sid) {
      try {
        const session = await this.dp.get("session", payload.sid);
        if (!(session.is_active as boolean)) {
          throw new Error("Session has been revoked");
        }
      } catch {
        throw new Error("Session not found or revoked");
      }
    }

    // Issue new access token
    const accessToken = await this.signToken(
      {
        sub: payload.sub,
        email: payload.email,
        groups: payload.groups,
        type: "access",
        sid: payload.sid,
      },
      this.accessTTL,
    );

    const expiresAt = new Date(Date.now() + this.accessTTL * 1000).toISOString();
    return { access_token: accessToken, expires_at: expiresAt };
  }

  async createApiKey(
    ctx: ActionContext,
    input: { name: string; scopes?: unknown; expires_at?: string },
  ): Promise<CreateApiKeyResult> {
    const rawKey = `lk_${generateRandomToken()}`;
    const keyPrefix = rawKey.slice(0, 11); // "lk_" + first 8 hex chars
    const keyHash = await sha256(rawKey);

    await this.dp.create("api_key", {
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
  }

  async resetPassword(
    _ctx: ActionContext,
    input: { email?: string; token?: string; new_password?: string },
  ): Promise<ResetPasswordResult> {
    // Phase 1: Generate reset token
    if (input.email && !input.token) {
      const users = await this.dp.query("user", { email: input.email, limit: 1 });
      const user = users[0];
      if (!user) {
        // Return success even if user not found (prevent email enumeration)
        return { success: true };
      }
      const userId = user.id as string;

      const resetToken = generateRandomToken();
      const tokenHash = await sha256(resetToken);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour

      await this.dp.create("token", {
        user_id: userId,
        token_hash: tokenHash,
        type: "access", // Reuse 'access' type for reset tokens
        expires_at: expiresAt,
      });

      // In production, send email with resetToken here.
      // For now, log it in dev mode.
      console.log(`[drizzle-provider] Password reset token for ${input.email}: ${resetToken}`);

      return { success: true };
    }

    // Phase 2: Verify token and update password
    if (input.token && input.new_password) {
      const tokenHash = await sha256(input.token);

      // Find token record by hash
      const tokens = await this.dp.query("token", { token_hash: tokenHash, limit: 1 });
      const tokenRecord = tokens[0];
      if (!tokenRecord) {
        throw new Error("Invalid or expired reset token");
      }

      const expiresAt = new Date(tokenRecord.expires_at as string);
      if (expiresAt < new Date()) {
        throw new Error("Invalid or expired reset token");
      }
      if (tokenRecord.revoked_at) {
        throw new Error("Invalid or expired reset token");
      }

      const userId = tokenRecord.user_id as string;

      // Hash new password and update user
      const passwordHash = await Bun.password.hash(input.new_password);
      await this.dp.update("user", userId, { password_hash: passwordHash });

      // Revoke the token
      await this.dp.update("token", tokenRecord.id as string, {
        revoked_at: new Date().toISOString(),
      });

      return { success: true };
    }

    throw new Error("Invalid reset password request: provide email or token + new_password");
  }

  // ── Token/credential resolution (used by auth middleware) ──

  async resolveToken(token: string): Promise<Actor | null> {
    const payload = await this.verifyToken(token);
    if (!payload || payload.type !== "access") return null;

    return {
      type: "human",
      id: payload.sub,
      name: payload.email,
      groups: payload.groups,
    };
  }

  async resolveApiKey(key: string): Promise<Actor | null> {
    if (!key.startsWith("lk_")) return null;

    const keyHash = await sha256(key);
    const keyPrefix = key.slice(0, 11);

    // Find API key by prefix first for efficiency, then verify hash
    const keys = await this.dp.query("api_key", {
      key_prefix: keyPrefix,
      is_active: true,
      limit: 10,
    });

    for (const apiKey of keys) {
      if ((apiKey.key_hash as string) === keyHash) {
        // Check expiration
        if (apiKey.expires_at) {
          const expiresAt = new Date(apiKey.expires_at as string);
          if (expiresAt < new Date()) return null;
        }

        // Update last_used_at
        try {
          await this.dp.update("api_key", apiKey.id as string, {
            last_used_at: new Date().toISOString(),
          });
        } catch {
          // Non-critical update, ignore errors
        }

        // Resolve user for the API key
        const userId = apiKey.user_id as string;
        try {
          const user = await this.dp.get("user", userId);
          return {
            type: "human",
            id: userId,
            name: (user.email as string) ?? (user.name as string),
            groups: (user.groups as string[]) ?? [],
            metadata: { api_key_id: apiKey.id, scopes: apiKey.scopes },
          };
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  async resolveSession(sessionId: string): Promise<Actor | null> {
    try {
      const session = await this.dp.get("session", sessionId);
      if (!(session.is_active as boolean)) return null;

      const expiresAt = new Date(session.expires_at as string);
      if (expiresAt < new Date()) return null;

      const userId = session.user_id as string;
      const user = await this.dp.get("user", userId);

      return {
        type: "human",
        id: userId,
        name: (user.email as string) ?? (user.name as string),
        groups: (user.groups as string[]) ?? [],
      };
    } catch {
      return null;
    }
  }
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Create a production DrizzleAuthProvider backed by PostgreSQL via DataProvider.
 *
 * Usage:
 * ```ts
 * import { createDrizzleAuthProvider } from '@linchkit/cap-auth'
 *
 * const provider = createDrizzleAuthProvider({
 *   dataProvider: drizzleDataProvider,
 *   jwtSecret: process.env.JWT_SECRET!,
 * })
 * ```
 */
export function createDrizzleAuthProvider(options: DrizzleAuthProviderOptions): AuthProvider {
  return new DrizzleAuthProvider(options);
}

// ── System admin seeding ─────────────────────────────────────

export interface InitSystemAdminOptions {
  dataProvider: DataProvider;
  email?: string;
  password?: string;
}

/**
 * Seed the system admin user on startup.
 *
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from env (or accepts explicit values).
 * If the admin user does not exist, creates one with system_admin group.
 */
export async function initSystemAdmin(options: InitSystemAdminOptions): Promise<void> {
  const email = options.email ?? process.env.ADMIN_EMAIL;
  const password = options.password ?? process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("[auth] No ADMIN_EMAIL/ADMIN_PASSWORD set — skipping admin seeding");
    return;
  }

  // Check if admin already exists
  const existing = await options.dataProvider.query("user", { email, limit: 1 });
  if (existing.length > 0) {
    console.log(`[auth] System admin already exists: ${email}`);
    return;
  }

  // Create admin user
  const passwordHash = await Bun.password.hash(password);
  await options.dataProvider.create("user", {
    email,
    name: "System Administrator",
    password_hash: passwordHash,
    status: "active",
    groups: ["system_admin"],
  });

  console.log(`[auth] System admin created: ${email}`);
}
