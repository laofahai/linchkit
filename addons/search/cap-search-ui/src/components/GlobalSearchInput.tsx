/**
 * GlobalSearchInput — controlled text input wired to a parent-supplied
 * `onSearch` callback.
 *
 * UX:
 * - ⌘K / Ctrl+K focuses the input from anywhere on the page.
 * - Esc clears the input and emits an empty query.
 * - The input is fully controlled; debouncing / network calls live in
 *   the parent (see SearchPanel) — this widget is intentionally dumb so
 *   it can be reused as an omnibox slot in custom shells.
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import { Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Return a platform-appropriate keyboard hint string. We avoid touching
 * `navigator` at module load so SSR / test environments without a DOM
 * stay deterministic; the effect re-runs after hydration on the client.
 */
function useShortcutHint(): string {
  const [hint, setHint] = useState<string>("⌘K");
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const platform = navigator.platform || "";
    const userAgent = navigator.userAgent || "";
    const isApple = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac|iPhone|iPad|iPod/.test(userAgent);
    setHint(isApple ? "⌘K" : "Ctrl K");
  }, []);
  return hint;
}

export interface GlobalSearchInputProps {
  value: string;
  onSearch: (query: string) => void;
  placeholder?: string;
  className?: string;
  /** When true, the ⌘K / Ctrl+K shortcut is bound to focus this input. */
  enableShortcut?: boolean;
  /** Optional id (test hook / a11y label association). */
  id?: string;
  /** Accessible label for the search input. */
  ariaLabel?: string;
}

export function GlobalSearchInput(props: GlobalSearchInputProps) {
  const { t } = useTranslation();
  const {
    value,
    onSearch,
    placeholder = t("search.input.placeholder", "Search..."),
    className,
    enableShortcut = true,
    id = "global-search-input",
    ariaLabel = t("search.input.ariaLabel", "Global search"),
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!enableShortcut) return;
    function handleGlobalKey(event: globalThis.KeyboardEvent) {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      // Bail when the user is already typing into a different editable
      // element — they almost certainly meant the platform shortcut, not
      // ours (e.g. Ctrl-K in a textarea / contentEditable).
      const target = event.target as HTMLElement | null;
      if (target && target !== inputRef.current) {
        const tag = target.tagName;
        const isEditable =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
        if (isEditable) return;
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [enableShortcut]);

  // Show the platform-correct shortcut hint (⌘K on Apple, Ctrl K elsewhere).
  // Default to `⌘K` for SSR / non-browser contexts so the rendered output
  // is deterministic; the effect below adjusts after hydration.
  const shortcutHint = useShortcutHint();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSearch("");
        inputRef.current?.blur();
      }
    },
    [onSearch],
  );

  return (
    <div className={cn("relative w-full max-w-xl", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {/*
        Native <input> rather than ui-kit <Input> — the latter doesn't
        forward refs (React 19 component without explicit ref prop) and
        we need an imperative focus handle for the ⌘K shortcut. Styles
        below mirror the ui-kit Input visual to stay consistent.
      */}
      <input
        ref={inputRef}
        id={id}
        type="search"
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onSearch(event.target.value)}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent pl-8 pr-12 py-1 text-sm transition-colors outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      {enableShortcut && (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 select-none rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
          {shortcutHint}
        </kbd>
      )}
    </div>
  );
}

export default GlobalSearchInput;
