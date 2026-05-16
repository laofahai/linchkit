/**
 * <ThemeProvider> — top-level theme controller.
 *
 * Responsibilities:
 *  1. Hold the user's `mode` preference in React state.
 *  2. Hydrate from `localStorage` on mount (never during initial render — keeps
 *     SSR output deterministic and avoids `window`/`document` access in
 *     Node).
 *  3. Subscribe to `(prefers-color-scheme: dark)` while `mode === "system"`
 *     so `resolvedMode` updates reactively when the OS flips theme.
 *  4. Apply `document.documentElement.classList.toggle("dark", …)` whenever
 *     `resolvedMode` changes so Tailwind's `dark:` variant lights up.
 *
 * SSR contract: the first render uses `defaultMode` and a best-effort initial
 * `resolvedMode` of `"light"`. The real persisted/system values are picked up
 * in the mount `useEffect`, which produces a single deterministic post-hydration
 * re-render. This matches the React 19 / Vite SSR story used by cap-adapter-ui.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { readStoredTheme } from "./theme-storage";
import { commitMode, resolveMode } from "./transitions";
import type { ResolvedTheme, ThemeContextValue, ThemeMode } from "./types";
import { ThemeContext } from "./use-theme";

export interface ThemeProviderProps {
  /** Children that read the theme via {@link useTheme}. */
  children: ReactNode;
  /**
   * Mode to use before the storage hydration + system probe complete.
   * Defaults to `"system"` which mirrors the previous ui-kit behaviour.
   */
  defaultMode?: ThemeMode;
}

/**
 * Apply the resolved scheme to `<html>` so Tailwind's `dark:` selector
 * (configured as `&:is(.dark *)` in cap-adapter-ui's stylesheet) activates.
 *
 * Guarded for SSR: a no-op when `document` is unavailable.
 */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children, defaultMode = "system" }: ThemeProviderProps) {
  // `mode` is the user preference; `resolvedMode` is what's actually applied.
  // We initialise both synchronously to keep the first render deterministic and
  // SSR-safe (no `window`/`document` access here — that happens in `useEffect`).
  const [mode, setModeState] = useState<ThemeMode>(defaultMode);
  const [resolvedMode, setResolvedMode] = useState<ResolvedTheme>(() =>
    defaultMode === "dark" ? "dark" : "light",
  );

  // Tracks whether we've completed the initial hydration. State (not ref) so
  // React re-renders before the mode-change effect runs — otherwise the two
  // effects can fire on the same commit and the mode-change branch sees a
  // stale `mode` while believing hydration is done.
  const [hasHydrated, setHasHydrated] = useState(false);

  // ── Hydration: read persisted preference + probe matchMedia once. ──
  useEffect(() => {
    // Run only on mount — re-firing on prop changes would clobber any user
    // toggle. `hasHydrated` also short-circuits the mode-change effect below
    // until this completes.
    if (hasHydrated) return;
    const stored = readStoredTheme();
    const effective = stored ?? defaultMode;
    setModeState(effective);
    setResolvedMode(resolveMode(effective));
    setHasHydrated(true);
  }, [defaultMode, hasHydrated]);

  // ── React to mode changes: persist + recompute resolved scheme. ──
  useEffect(() => {
    if (!hasHydrated) return; // wait until the hydrated mode has rendered
    setResolvedMode(commitMode(mode));
  }, [hasHydrated, mode]);

  // ── Apply resolved scheme to the DOM. ──
  useEffect(() => {
    applyResolvedTheme(resolvedMode);
  }, [resolvedMode]);

  // ── Listen for OS theme flips while in `"system"` mode. ──
  useEffect(() => {
    if (mode !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setResolvedMode(event.matches ? "dark" : "light");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedMode, setMode }),
    [mode, resolvedMode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
