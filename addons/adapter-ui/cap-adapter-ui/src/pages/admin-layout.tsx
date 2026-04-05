/**
 * AdminLayout — Admin section layout with sidebar navigation.
 *
 * Reads registered admin routes from the route registry, filters by active
 * capabilities, and renders a sidebar with lazy-loaded route components.
 */

import { Link, useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type AdminRouteRegistration, getAdminRoutes } from "../lib/route-registry";

// Ensure built-in admin routes are registered
import "../lib/builtin-admin-routes";

/** Resolve a Lucide icon component by PascalCase name */
function useLucideIcon(name?: string) {
  // Dynamically import from lucide-react is complex; use a simple fallback
  // In practice, the sidebar renders the icon name as text if not resolved
  return name;
}

function AdminNavItem({ route, isActive }: { route: AdminRouteRegistration; isActive: boolean }) {
  const { t } = useTranslation();
  const iconName = useLucideIcon(route.icon);

  return (
    <Link
      to={route.path as "/"}
      className={[
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
      ].join(" ")}
    >
      {iconName && <span className="text-xs opacity-70">{iconName}</span>}
      <span>{t(route.label, route.label)}</span>
    </Link>
  );
}

export function AdminLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const routes = useMemo(() => getAdminRoutes(), []);

  // Find the active route based on current path
  const activeRoute = routes.find((r) => location.pathname.startsWith(r.path));

  // Lazy-load the active component
  const ActiveComponent = useMemo(() => {
    if (!activeRoute) return null;
    return lazy(activeRoute.component);
  }, [activeRoute]);

  return (
    <div className="flex h-full">
      {/* Sidebar navigation */}
      <nav className="w-56 shrink-0 border-r bg-muted/30 p-3">
        <h2 className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.title", "Administration")}
        </h2>
        <div className="flex flex-col gap-1">
          {routes.map((route) => (
            <AdminNavItem
              key={route.id}
              route={route}
              isActive={location.pathname.startsWith(route.path)}
            />
          ))}
        </div>
      </nav>

      {/* Main content area */}
      <div className="flex-1 overflow-auto">
        {ActiveComponent ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center p-12 text-muted-foreground">
                {t("common.loading", "Loading...")}
              </div>
            }
          >
            <ActiveComponent />
          </Suspense>
        ) : (
          <div className="flex items-center justify-center p-12 text-muted-foreground">
            {t("admin.selectPage", "Select a page from the sidebar")}
          </div>
        )}
      </div>
    </div>
  );
}
