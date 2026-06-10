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

/** An admin-route registry instance (register + sorted read). */
export interface AdminRouteRegistry {
  register(route: AdminRouteRegistration): void;
  getAll(): AdminRouteRegistration[];
}

/**
 * Create an isolated admin-route registry. Unit tests construct their own
 * instance — NEVER clear the shared module singleton below: capability
 * packages (cap-adapter-mcp UI, …) register into it at import time and assert
 * on it, and under bun's batched test run a shared-singleton clear races
 * those import-time registrations (#539).
 */
export function createAdminRouteRegistry(): AdminRouteRegistry {
  const items: AdminRouteRegistration[] = [];
  return {
    register(route: AdminRouteRegistration): void {
      if (items.some((r) => r.id === route.id)) {
        throw new Error(`Admin route "${route.id}" is already registered`);
      }
      items.push(route);
    },
    getAll(): AdminRouteRegistration[] {
      return [...items].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    },
  };
}

/** The shared app-wide registry capability packages register into on import. */
const defaultRegistry = createAdminRouteRegistry();

/**
 * Register an admin route. Throws if a route with the same ID is already registered.
 */
export function registerAdminRoute(route: AdminRouteRegistration): void {
  defaultRegistry.register(route);
}

/**
 * Get all registered admin routes, sorted by order (ascending).
 * Returns a shallow copy to prevent external mutation.
 */
export function getAdminRoutes(): AdminRouteRegistration[] {
  return defaultRegistry.getAll();
}
