/**
 * useGlobalShortcuts — Registers app-wide keyboard shortcuts.
 *
 * Shortcuts:
 * - Cmd+N / Ctrl+N: Navigate to "new record" form when on a schema list page.
 *
 * Note: Cmd+K is handled by CommandPalette directly.
 * Escape is handled natively by Dialog/Sheet components (Radix).
 */

import { useEffect } from "react";

/**
 * Activate global keyboard shortcuts. Call once in the shell layout.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+N / Ctrl+N — new record (only on schema list pages)
      if (e.key === "n" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const match = window.location.pathname.match(/^\/entities\/([^/]+)$/);
        if (match) {
          e.preventDefault();
          const entityName = match[1];
          window.history.pushState({}, "", `/entities/${entityName}/new`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
