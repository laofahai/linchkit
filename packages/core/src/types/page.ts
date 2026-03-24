/**
 * Page registration — lightweight type for Capability-provided standalone pages.
 *
 * Pages are NOT Views. Views are Schema-bound (list/form/kanban).
 * Pages are standalone application pages (login, register, dashboard, permission matrix).
 *
 * Capabilities register pages via their CapabilityDefinition.
 * The UI layer reads page registrations and creates routes accordingly.
 */

/** Layout variant for the page */
export type PageLayout = "shell" | "fullscreen" | "centered";

/** Authentication requirement for accessing the page */
export type PageAuth = "required" | "anonymous" | "any";

export interface PageRegistration {
  /** Unique page name (e.g., "auth:login", "permission:matrix") */
  name: string;
  /** URL path (e.g., "/login", "/register") */
  path: string;
  /** Human-readable label */
  label?: string;
  /** Layout variant — "shell" (with sidebar), "centered" (auth pages), "fullscreen" */
  layout: PageLayout;
  /** Auth requirement — "required" (must login), "anonymous" (must NOT be logged in), "any" */
  auth: PageAuth;
  /** Redirect path when auth requirement is not met */
  redirectOnFail?: string;
  /** Component identifier — resolved by UI layer's page registry */
  component: string;
  /** Props to pass to the component */
  props?: Record<string, unknown>;
  /** Sort order in navigation (if shown in nav) */
  order?: number;
  /** Whether to show this page in navigation */
  showInNav?: boolean;
}
