/**
 * Public entry point for @linchkit/cap-theme.
 *
 * Side-effect import (`./i18n`) seeds the shared react-i18next instance with
 * the capability's en / zh-CN bundles before any view consuming
 * `t("theme.…")` mounts. Kept above the named exports so importing
 * `ThemeToggle` automatically pulls the translations.
 */

import "./i18n";

export { capTheme } from "./capability";
export { resolveSystemTheme } from "./system-theme";
export { ThemeProvider, type ThemeProviderProps } from "./ThemeProvider";
export { THEME_CYCLE, ThemeToggle, type ThemeToggleProps } from "./ThemeToggle";
export {
  clearStoredTheme,
  readStoredTheme,
  writeStoredTheme,
} from "./theme-storage";
export { commitMode, nextMode, resolveMode } from "./transitions";
export type { ResolvedTheme, ThemeContextValue, ThemeMode } from "./types";
export { THEME_STORAGE_KEY } from "./types";
export { useTheme } from "./use-theme";
