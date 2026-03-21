import { Bell, Search, User } from "lucide-react";
import { cn } from "../lib/utils";

interface CommandBarProps {
  onToggleSidebar: () => void;
}

/** Top command bar: Command Palette trigger (Cmd+K), notifications, user menu */
export function CommandBar({ onToggleSidebar }: CommandBarProps) {
  return (
    <header
      className={cn(
        "flex h-12 items-center justify-between border-b border-gray-200 bg-white px-4",
      )}
    >
      {/* Left: brand + command palette trigger */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="text-sm font-semibold text-gray-900 hover:text-gray-700 lg:hidden"
          aria-label="Toggle sidebar"
        >
          LinchKit
        </button>
        <span className="hidden text-sm font-semibold text-gray-900 lg:inline">LinchKit</span>

        {/* Command Palette trigger — styled as a search input */}
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5",
            "text-sm text-gray-400 transition-colors hover:border-gray-300 hover:bg-gray-100",
            "w-64 lg:w-96",
          )}
          aria-label="Open command palette"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search or jump to...</span>
          <kbd className="hidden rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-400 sm:inline">
            Cmd+K
          </kbd>
        </button>
      </div>

      {/* Right: notifications + user */}
      <div className="flex items-center gap-2">
        {/* Notification bell placeholder */}
        <button
          type="button"
          className="relative rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
        </button>

        {/* User avatar placeholder */}
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-gray-600 hover:bg-gray-300"
          aria-label="User menu"
        >
          <User className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
