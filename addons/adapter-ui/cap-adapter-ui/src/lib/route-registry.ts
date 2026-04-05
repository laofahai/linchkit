/**
 * Admin Route Registry — Register and resolve admin page routes.
 *
 * Capabilities register their admin pages at import time.
 * The admin layout reads the registry to build navigation and lazy-load components.
 */

import type React from "react";

export interface AdminRouteRegistration {
  /** Unique identifier (e.g. "executions", "mcp") */
  id: string;
  /** Capability name or "__builtin__" */
  capability: string;
  /** Route path (e.g. "/admin/executions") */
  path: string;
  /** i18n key for the route label */
  label: string;
  /** Lucide icon name (PascalCase) */
  icon?: string;
  /** Sort order (default: 100) */
  order?: number;
  /** Lazy-loaded component */
  component: () => Promise<{ default: React.ComponentType }>;
  /** Sub-routes for nested pages */
  children?: AdminRouteRegistration[];
}

const registry: AdminRouteRegistration[] = [];

/**
 * Register an admin route. Throws if a route with the same ID is already registered.
 */
export function registerAdminRoute(route: AdminRouteRegistration): void {
  if (registry.some((r) => r.id === route.id)) {
    throw new Error(`Admin route "${route.id}" is already registered`);
  }
  registry.push(route);
}

/**
 * Get all registered admin routes, sorted by order (ascending).
 * Returns a shallow copy to prevent external mutation.
 */
export function getAdminRoutes(): AdminRouteRegistration[] {
  return [...registry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * Clear all registered routes. Only for testing.
 * @internal
 */
export function _clearAdminRoutes(): void {
  registry.length = 0;
}
