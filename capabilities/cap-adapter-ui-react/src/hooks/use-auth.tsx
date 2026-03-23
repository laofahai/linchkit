/**
 * useAuth — Provides authentication state from stored token.
 *
 * Supports both JWT tokens (header.payload.signature) and plain base64
 * tokens (used by DevAuthProvider). No verification is done client-side —
 * the server validates the token on each request.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { logout as authLogout, loginWithPassword } from "@/lib/auth-client";

const TOKEN_STORAGE_KEY = "linchkit:token";
const AUTH_STORAGE_KEY = "linchkit:authenticated";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  groups: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  login: async () => {},
  logout: async () => {},
});

/**
 * Decode a token payload. Handles two formats:
 * 1. JWT (three dot-separated base64 segments) — decodes the middle segment
 * 2. Plain base64 JSON (DevAuthProvider) — decodes the whole string
 */
function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const raw = parts.length === 3 ? (parts[1] ?? token) : token;
    // Normalize base64url to standard base64 (replace -/_ and pad)
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/** Extract AuthUser from decoded token payload. */
function extractUser(payload: Record<string, unknown>): AuthUser | null {
  // JWT tokens use `sub` for user id; DevAuthProvider uses `userId`
  const id = (payload.sub ?? payload.userId) as string | undefined;
  if (!id) return null;

  return {
    id,
    name: (payload.name as string) ?? (payload.email as string) ?? "",
    email: (payload.email as string) ?? "",
    groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : [],
  };
}

/** Check whether the token has expired (exp claim, milliseconds or seconds). */
function isTokenExpired(payload: Record<string, unknown>): boolean {
  const exp = payload.exp;
  if (typeof exp !== "number") return false;
  // DevAuthProvider uses milliseconds, JWT uses seconds.
  // Heuristic: if exp > 1e12 it's milliseconds, otherwise seconds.
  const expiresAtMs = exp > 1e12 ? exp : exp * 1000;
  return Date.now() >= expiresAtMs;
}

function readUserFromToken(): AuthUser | null {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return null;

  const payload = decodeTokenPayload(token);
  if (!payload || isTokenExpired(payload)) {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }

  return extractUser(payload);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Read token on mount
  useEffect(() => {
    setUser(readUserFromToken());
    setIsLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await loginWithPassword(email, password);
    setUser(readUserFromToken());
  }, []);

  const logout = useCallback(async () => {
    await authLogout();
    setUser(null);
    window.location.href = "/login";
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      login,
      logout,
    }),
    [user, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
