/**
 * Tenant management — stores and retrieves the active tenant ID.
 *
 * The tenant ID is sent as X-Tenant-Id header on all API requests.
 * Persisted to localStorage so it survives page reloads.
 */

const STORAGE_KEY = "linchkit:tenant-id";

/** Tenant descriptor returned by the server or configured locally. */
export interface TenantInfo {
  id: string;
  name: string;
}

/**
 * Get the currently active tenant ID from localStorage.
 * Returns null if no tenant is selected.
 */
export function getActiveTenantId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * Set the active tenant ID. Pass null to clear.
 */
export function setActiveTenantId(tenantId: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (tenantId) {
    localStorage.setItem(STORAGE_KEY, tenantId);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Build tenant-related request headers.
 * Returns an empty object if no tenant is selected.
 */
export function getTenantHeaders(): Record<string, string> {
  const tenantId = getActiveTenantId();
  if (tenantId) {
    return { "X-Tenant-Id": tenantId };
  }
  return {};
}
