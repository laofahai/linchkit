/**
 * Public type surface for cap-theme.
 *
 * Kept in its own module so consumers can `import type { ThemeMode }` without
 * pulling in React or the storage helper.
 */

/**
 * The user-selectable theme preference.
 *
 * - `"system"` follows the operating system's color-scheme media query.
 * - `"light"` / `"dark"` are explicit overrides that ignore the OS setting.
 */
export type ThemeMode = "system" | "light" | "dark";

/**
 * The concrete color scheme that is actually applied to the DOM.
 *
 * When {@link ThemeMode} is `"system"`, this resolves to either `"light"` or
 * `"dark"` depending on the current `prefers-color-scheme` match. For the
 * explicit modes it mirrors the user choice.
 */
export type ResolvedTheme = "light" | "dark";

/**
 * Value exposed by {@link useTheme}.
 */
export interface ThemeContextValue {
  /** Current user preference (may be `"system"`). */
  mode: ThemeMode;
  /** Currently applied scheme, never `"system"`. */
  resolvedMode: ResolvedTheme;
  /** Update the user preference (also persists to storage). */
  setMode: (mode: ThemeMode) => void;
}

/**
 * localStorage key used to persist the user's mode preference.
 *
 * Scoped under the `linchkit:` namespace to avoid colliding with the legacy
 * `linchkit-theme` key written by the ui-kit hook that this capability is
 * eventually replacing (see issue #121).
 */
export const THEME_STORAGE_KEY = "linchkit:theme";
