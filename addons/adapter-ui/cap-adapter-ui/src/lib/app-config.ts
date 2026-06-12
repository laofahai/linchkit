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
