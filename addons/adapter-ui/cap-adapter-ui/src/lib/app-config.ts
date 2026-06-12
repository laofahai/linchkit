/**
 * App configuration client — fetches and caches the server's app-config payload.
 */

/** Menu item registered by a capability */
export interface MenuItemConfig {
  id: string;
  label: string;
  path: string;
  icon?: string;
  section?: "main" | "admin";
  order?: number;
  auth?: "required" | "anonymous" | "optional";
}

/** Application config returned by GET /api/app-config */
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
let fetchPromise: Promise<AppConfig> | null = null;

/** Returns true once fetchAppConfig() has successfully populated the cache. */
export function isAppConfigLoaded(): boolean {
  return cachedAppConfig !== null;
}

/**
 * Fetch app config from the server.
 * Only caches on successful fetch — errors are not cached so the next
 * page load will retry (prevents permanent empty menus after startup glitch).
 * Concurrent callers share one in-flight request; the promise is cleared on
 * settlement so a subsequent call after an error will retry.
 */
export async function fetchAppConfig(): Promise<AppConfig> {
  if (cachedAppConfig) return cachedAppConfig;
  if (fetchPromise) return fetchPromise;
  const fallback: AppConfig = {
    authEnabled: false,
    aiEnabled: false,
    capabilities: [],
    pages: [],
    menuItems: [],
  };
  fetchPromise = (async () => {
    try {
      const res = await fetch("/api/app-config");
      if (!res.ok) return fallback;
      const json = await res.json();
      if (json.data) {
        cachedAppConfig = json.data;
        return cachedAppConfig as AppConfig;
      }
      return fallback;
    } catch {
      return fallback;
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/**
 * Check whether auth is enabled. Uses cached config when available,
 * otherwise returns false (safe default for initial page load).
 */
export function isAuthEnabled(): boolean {
  return cachedAppConfig?.authEnabled ?? false;
}

/**
 * Check whether AI service is enabled. Uses cached config when available,
 * otherwise returns false (safe default for initial page load).
 */
export function isAiEnabled(): boolean {
  return cachedAppConfig?.aiEnabled ?? false;
}

/**
 * Get registered menu items from cached app config.
 * Returns empty array before config is fetched.
 */
export function getMenuItems(): MenuItemConfig[] {
  return cachedAppConfig?.menuItems ?? [];
}

/**
 * Get active capability names from cached app config.
 * Returns empty array before config is fetched.
 */
export function getActiveCapabilities(): string[] {
  return cachedAppConfig?.capabilities ?? [];
}
