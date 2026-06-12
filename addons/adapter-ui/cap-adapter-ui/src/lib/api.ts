/**
 * API client foundations: auth helpers and app-config.
 *
 * Domain-specific clients live in focused sibling modules:
 *   entity-api.ts     — Entity CRUD, list/query, state transitions
 *   entity-meta.ts    — Entity metadata, relations, onchange (Spec 64)
 *   action-api.ts     — REST action execution
 *   ai-api.ts         — AI endpoints (auto-fill, search, intent resolution)
 *   chatter-api.ts    — Chatter timeline
 *   execution-log-api.ts — Execution logs, state transition history
 *   config-api.ts     — Runtime config + ConfigStore KV (Spec 42)
 *   graphql.ts        — Low-level GraphQL fetch helper
 */

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

// ── App config ──────────────────────────────────────────

export interface MenuItemConfig {
  id: string;
  label: string;
  path: string;
  icon?: string;
  section?: "main" | "admin";
  order?: number;
  auth?: "required" | "anonymous" | "optional";
}

export interface AppConfig {
  authEnabled: boolean;
  aiEnabled: boolean;
  capabilities: string[];
  pages: Array<{
    name: string;
    path: string;
    label?: string;
    layout: string;
    auth: string;
    redirectOnFail?: string;
    component: string;
    props?: Record<string, unknown>;
    order?: number;
    showInNav?: boolean;
  }>;
  menuItems?: MenuItemConfig[];
}

let cachedAppConfig: AppConfig | null = null;

/**
 * Fetch app config from the server.
 * Only caches on successful fetch — errors are not cached so the next
 * page load will retry (prevents permanent empty menus after startup glitch).
 */
export async function fetchAppConfig(): Promise<AppConfig> {
  if (cachedAppConfig) return cachedAppConfig;
  const fallback: AppConfig = {
    authEnabled: false,
    aiEnabled: false,
    capabilities: [],
    pages: [],
    menuItems: [],
  };
  try {
    const res = await fetch("/api/app-config");
    const json = await res.json();
    if (json.data) {
      cachedAppConfig = json.data;
      return cachedAppConfig as AppConfig;
    }
    // Server responded but returned no data — don't cache, return fallback
    return fallback;
  } catch {
    // Server unreachable — return fallback without caching so next load retries
    return fallback;
  }
}

export function isAuthEnabled(): boolean {
  return cachedAppConfig?.authEnabled ?? false;
}

export function isAiEnabled(): boolean {
  return cachedAppConfig?.aiEnabled ?? false;
}

export function getMenuItems(): MenuItemConfig[] {
  return cachedAppConfig?.menuItems ?? [];
}

export function getActiveCapabilities(): string[] {
  return cachedAppConfig?.capabilities ?? [];
}
