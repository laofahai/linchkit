/**
 * One-shot probe of the OS `prefers-color-scheme` setting.
 *
 * Extracted from the provider so unit tests can mock the function instead of
 * faking `window.matchMedia` globally — the React-free import surface keeps
 * the helper testable without jsdom.
 *
 * SSR contract: returns `"light"` whenever `window` / `matchMedia` are
 * unavailable, which matches the conservative default React 19 hydration uses.
 */

import type { ResolvedTheme } from "./types";

export function resolveSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}
