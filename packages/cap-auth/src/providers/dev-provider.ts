/**
 * Dev/mock AuthProvider for LinchKit development.
 *
 * Provides hardcoded users and simple base64 token encoding so that
 * the full auth flow can be exercised without requiring better-auth
 * or any database.
 *
 * NOT for production use.
 */

import type { ActionContext, Actor } from "@linchkit/core";
import type {
  AuthProvider,
  CreateApiKeyResult,
  LoginResult,
  RefreshResult,
  ResetPasswordResult,
} from "../types";

// ── Hardcoded dev users ──────────────────────────────────

interface DevUser {
  id: string;
  email: string;
  groups: string[];
}

const DEV_USERS: DevUser[] = [
  { id: "admin", email: "admin@linchkit.dev", groups: ["admin"] },
  { id: "user1", email: "user@linchkit.dev", groups: ["user"] },
];

// ── Token helpers ────────────────────────────────────────

interface DevTokenPayload {
  userId: string;
  email: string;
  exp: number;
}

const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

function encodeToken(payload: DevTokenPayload): string {
  const json = JSON.stringify(payload);
  // btoa works in Bun
  return btoa(json);
}

function decodeToken(token: string): DevTokenPayload | null {
  try {
    const json = atob(token);
    const payload = JSON.parse(json) as DevTokenPayload;
    if (!payload.userId || !payload.email || !payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── DevAuthProvider ──────────────────────────────────────

class DevAuthProvider implements AuthProvider {
  async login(
    _ctx: ActionContext,
    input: { email: string; password: string },
  ): Promise<LoginResult> {
    const user = DEV_USERS.find((u) => u.email === input.email);
    if (!user) {
      throw new Error(`[dev-provider] Unknown user: ${input.email}`);
    }

    // Any password is accepted in dev mode
    const now = Date.now();
    const exp = now + TOKEN_LIFETIME_MS;

    const accessToken = encodeToken({ userId: user.id, email: user.email, exp });
    const refreshToken = encodeToken({
      userId: user.id,
      email: user.email,
      exp: now + TOKEN_LIFETIME_MS * 24, // 24h for refresh
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: TOKEN_LIFETIME_MS / 1000,
    };
  }

  async logout(_ctx: ActionContext, _input: { session_id?: string }): Promise<void> {
    // No-op for dev provider — tokens are stateless
  }

  async refreshToken(
    _ctx: ActionContext,
    input: { refresh_token: string },
  ): Promise<RefreshResult> {
    const payload = decodeToken(input.refresh_token);
    if (!payload || payload.exp < Date.now()) {
      throw new Error("[dev-provider] Invalid or expired refresh token");
    }

    const user = DEV_USERS.find((u) => u.id === payload.userId);
    if (!user) {
      throw new Error("[dev-provider] User not found for refresh token");
    }

    const exp = Date.now() + TOKEN_LIFETIME_MS;
    const accessToken = encodeToken({ userId: user.id, email: user.email, exp });

    return {
      access_token: accessToken,
      expires_at: new Date(exp).toISOString(),
    };
  }

  async createApiKey(
    _ctx: ActionContext,
    _input: { name: string; scopes?: unknown; expires_at?: string },
  ): Promise<CreateApiKeyResult> {
    // Stub — dev provider does not support API keys
    return { key: "lk_dev_mock_key", key_prefix: "lk_dev" };
  }

  async resetPassword(
    _ctx: ActionContext,
    _input: { email?: string; token?: string; new_password?: string },
  ): Promise<ResetPasswordResult> {
    // Stub — always succeeds in dev mode
    return { success: true };
  }

  // ── Token/credential resolution ────────────────────────

  async resolveToken(token: string): Promise<Actor | null> {
    const payload = decodeToken(token);
    if (!payload) return null;
    if (payload.exp < Date.now()) return null;

    const user = DEV_USERS.find((u) => u.id === payload.userId);
    if (!user) return null;

    return {
      type: "human",
      id: user.id,
      name: user.email,
      groups: user.groups,
    };
  }

  async resolveApiKey(_key: string): Promise<Actor | null> {
    // Not supported in dev provider
    return null;
  }

  async resolveSession(_sessionId: string): Promise<Actor | null> {
    // Not supported in dev provider
    return null;
  }
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create a dev/mock AuthProvider with hardcoded users.
 *
 * Usage:
 * ```ts
 * import { createCapAuth } from '@linchkit/cap-auth'
 * import { createDevAuthProvider } from '@linchkit/cap-auth/providers/dev-provider'
 *
 * const capAuth = createCapAuth({
 *   provider: createDevAuthProvider(),
 * })
 * ```
 */
export function createDevAuthProvider(): AuthProvider {
  return new DevAuthProvider();
}
