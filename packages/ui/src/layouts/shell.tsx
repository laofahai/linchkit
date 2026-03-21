import { Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { CommandBar } from "../components/command-bar";
import { Sidebar } from "../components/sidebar";

/** App Shell layout: command bar (top) + sidebar (left) + main workspace */
export function ShellLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <CommandBar onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar collapsed={sidebarCollapsed} />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
