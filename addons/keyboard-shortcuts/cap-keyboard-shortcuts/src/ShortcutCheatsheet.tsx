/**
 * `<ShortcutCheatsheet>` — modal overlay listing every registered shortcut
 * grouped by `scope`. Default open trigger is `Shift+?` (configurable via
 * `triggerKeys`); the overlay closes on `Escape`. Visibility is owned
 * locally so the component is drop-in — host apps can also pass `open` /
 * `onOpenChange` to control it externally.
 *
 * Rendering stays intentionally framework-light: we use plain divs +
 * Tailwind utility classes so cap-keyboard-shortcuts has no dependency
 * on the ui-kit. Translations resolve through `react-i18next` against
 * the bundles registered by the capability's `i18n` extension.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { detectPlatform, formatKeys } from "./key-matcher";
import { useShortcutRegistry } from "./ShortcutProvider";
import type { ShortcutSnapshot } from "./types";
import { useShortcut } from "./use-shortcut";

export interface ShortcutCheatsheetProps {
  /**
   * Key combination that toggles the overlay. Defaults to `"Shift+?"`.
   * Pass `null` to disable the built-in trigger and rely on `open`.
   */
  triggerKeys?: string | null;
  /** External controlled-open hook. */
  open?: boolean;
  /** Called whenever the overlay should open/close. */
  onOpenChange?: (open: boolean) => void;
}

const DEFAULT_TRIGGER = "Shift+?";

export function ShortcutCheatsheet(props: ShortcutCheatsheetProps) {
  const { triggerKeys = DEFAULT_TRIGGER, open, onOpenChange } = props;
  const { t } = useTranslation();
  const registry = useShortcutRegistry();
  const platform = useMemo(() => detectPlatform(), []);

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? Boolean(open) : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  // Built-in toggle shortcut. We register only when triggerKeys is set so
  // hosts can opt out cleanly.
  useShortcut({
    keys: triggerKeys ?? "Shift+F24", // unreachable key when disabled
    description: t("keyboardShortcuts.cheatsheet.toggleDescription", "Toggle shortcut cheatsheet"),
    scope: t("keyboardShortcuts.cheatsheet.scope", "Help"),
    handler: () => {
      if (triggerKeys === null) return;
      setOpen(!isOpen);
    },
  });

  // Esc to close — we wire this with a plain effect rather than a
  // shortcut so it works even when focus is in an editable element.
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, setOpen]);

  const snapshots = registry.listShortcuts();
  const grouped = useMemo(() => groupByScope(snapshots), [snapshots]);
  const scopes = Object.keys(grouped);

  if (!isOpen) return null;

  const title = t("keyboardShortcuts.cheatsheet.title", "Keyboard shortcuts");
  const emptyLabel = t("keyboardShortcuts.cheatsheet.empty", "No shortcuts are registered yet.");
  const closeLabel = t("keyboardShortcuts.cheatsheet.close", "Close");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Dedicated backdrop button — covers the inert area behind the
          dialog and is keyboard-activatable so a11y lint is happy. */}
      <button
        type="button"
        aria-label={closeLabel}
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={() => setOpen(false)}
      />
      <div className="relative max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={closeLabel}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        {scopes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="space-y-6">
            {scopes.map((scope) => {
              const items = grouped[scope];
              if (!items) return null;
              return (
                <section key={scope}>
                  <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
                    {scope}
                  </h3>
                  <ul className="space-y-1.5">
                    {items.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <span className="flex-1">{item.description}</span>
                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {formatKeys(item.keys, platform)}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function groupByScope(snapshots: readonly ShortcutSnapshot[]): Record<string, ShortcutSnapshot[]> {
  const grouped: Record<string, ShortcutSnapshot[]> = {};
  for (const snapshot of snapshots) {
    const key = snapshot.scope;
    const bucket = grouped[key] ?? [];
    bucket.push(snapshot);
    grouped[key] = bucket;
  }
  return grouped;
}
