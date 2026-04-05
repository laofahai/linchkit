/**
 * useKeyboardShortcuts — Centralized app-wide keyboard shortcut handler.
 *
 * Shortcuts:
 * - Cmd/Ctrl+K: Open command palette (delegates to onOpenCommandPalette callback)
 * - Cmd/Ctrl+N: Navigate to "new record" form when on a schema list page
 * - Cmd/Ctrl+S: Submit form when on a form page (auto-form)
 * - Escape: Close open modals/dialogs, clear table selection
 *
 * The hook skips navigation shortcuts (N) when focus is inside an
 * input, textarea, or contenteditable element to avoid interfering with typing.
 */

import { useEffect } from "react";

export interface KeyboardShortcutOptions {
  /** Callback to open the command palette (Cmd/Ctrl+K). */
  onOpenCommandPalette?: () => void;
}

/** Return true if the active element is a text input context. */
function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Activate global keyboard shortcuts. Call once in the shell layout.
 */
export function useKeyboardShortcuts(options: KeyboardShortcutOptions = {}) {
  const { onOpenCommandPalette } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // ── Cmd/Ctrl+K — Open command palette ──────────────────
      if (mod && e.key === "k" && !e.shiftKey && !e.altKey) {
        // Note: CommandPalette has its own Cmd+K listener that toggles
        // open/close. This callback provides an additional hook point
        // for the shell if needed. We do NOT preventDefault here so the
        // CommandPalette's own handler still fires.
        onOpenCommandPalette?.();
        return;
      }

      // ── Cmd/Ctrl+N — New record (schema list pages only) ──
      if (mod && e.key === "n" && !e.shiftKey && !e.altKey) {
        // Skip when typing in an input field
        if (isEditableElement(document.activeElement)) return;

        const match = window.location.pathname.match(/^\/entities\/([^/]+)$/);
        if (match) {
          e.preventDefault();
          const entityName = match[1];
          window.history.pushState({}, "", `/entities/${entityName}/new`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        return;
      }

      // ── Cmd/Ctrl+S — Save form ────────────────────────────
      if (mod && e.key === "s" && !e.shiftKey && !e.altKey) {
        e.preventDefault(); // Always prevent browser "Save page" dialog

        // Submit the auto-form if it exists on the current page
        const form = document.getElementById("auto-form") as HTMLFormElement | null;
        if (form) {
          form.requestSubmit();
        }
        return;
      }

      // ── Escape — Close modals / clear selection ────────────
      if (e.key === "Escape" && !mod && !e.shiftKey && !e.altKey) {
        // Radix Dialog/Sheet components handle their own Escape key,
        // so this primarily covers clearing table row selection and
        // blurring focused elements outside modals.
        const active = document.activeElement as HTMLElement | null;

        // If an input/textarea is focused, blur it
        if (active && isEditableElement(active)) {
          active.blur();
          return;
        }

        // Clear any table row checkbox selections by unchecking all
        const checkboxes = document.querySelectorAll<HTMLInputElement>(
          'table input[type="checkbox"]:checked',
        );
        if (checkboxes.length > 0) {
          for (const cb of checkboxes) {
            cb.click();
          }
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onOpenCommandPalette]);
}
