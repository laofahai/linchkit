import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Blocks, Database, LayoutDashboard, Settings } from "lucide-react";
import { cn } from "../lib/utils";

interface SidebarProps {
  collapsed: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const navSections: NavSection[] = [
  {
    title: "Workspace",
    items: [{ to: "/", label: "Home", icon: LayoutDashboard }],
  },
  {
    title: "Modules",
    items: [{ to: "/modules", label: "Capabilities", icon: Blocks }],
  },
  {
    title: "Admin",
    items: [
      { to: "/admin/schemas", label: "Schemas", icon: Database },
      { to: "/admin/events", label: "Events", icon: Activity },
      { to: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

/** Left sidebar navigation with sections: Workspace / Modules / Admin */
export function Sidebar({ collapsed }: SidebarProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-gray-200 bg-gray-50 transition-all duration-200",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3">
        {navSections.map((section) => (
          <div key={section.title} className="mb-4">
            {/* Section title — hidden when collapsed */}
            {!collapsed && (
              <div className="px-4 pb-1 text-xs font-medium uppercase tracking-wider text-gray-400">
                {section.title}
              </div>
            )}

            <div className="space-y-0.5 px-2">
              {section.items.map((item) => {
                const isActive = currentPath === item.to;
                return (
                  <Link
                    key={item.label}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-gray-200 text-gray-900"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                      collapsed && "justify-center px-2",
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="h-5 w-5 shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
