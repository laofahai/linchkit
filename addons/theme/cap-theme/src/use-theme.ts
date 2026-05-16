/**
 * Theme context + `useTheme` hook.
 *
 * Owns the active {@link ThemeMode} for the React tree and exposes both the
 * raw user choice (`mode`) and the resolved scheme actually applied to the
 * DOM (`resolvedMode`). Mode changes are persisted via {@link writeStoredTheme}
 * and broadcast to all consumers through React context.
 *
 * The matchMedia subscription and the `documentElement.classList` toggle are
 * intentionally kept inside the provider's `useEffect` so the module is safe
 * to import during SSR / Node-side test runs without touching `window`.
 */

import { createContext, useContext } from "react";
import type { ThemeContextValue } from "./types";

/**
 * Context value, `null` when no {@link ThemeProvider} is mounted above.
 *
 * Kept null-able so we can throw a descriptive error in {@link useTheme}
 * instead of silently returning a default — a missing provider is almost
 * always a setup bug worth surfacing.
 */
export const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Subscribe to the current theme.
 *
 * @throws If called outside a {@link ThemeProvider}.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return value;
}
