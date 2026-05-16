/**
 * Pure transition helpers for the theme state machine.
 *
 * Kept React-free so the cycle order and the storage/system composition can be
 * unit-tested without a renderer. The provider wires these together with React
 * state.
 */

import { writeStoredTheme } from "./theme-storage";
import { resolveSystemTheme } from "./system-theme";
import type { ResolvedTheme, ThemeMode } from "./types";

/**
 * Order used by {@link ThemeToggle} when cycling through preferences.
 *
 * The sequence matches the typical macOS / Linux desktop pattern where the
 * "auto" position sits between the two explicit ones, so cycling once from
 * any state always reaches a meaningful neighbour.
 */
export const THEME_CYCLE: readonly ThemeMode[] = ["system", "light", "dark"];

/**
 * Compute the next mode in the {@link THEME_CYCLE}.
 *
 * Falls back to the first entry when the current mode is unrecognised — keeps
 * recovery automatic if storage hands back something off the enum.
 */
export function nextMode(current: ThemeMode): ThemeMode {
  const idx = THEME_CYCLE.indexOf(current);
  if (idx === -1) return THEME_CYCLE[0] ?? "system";
  // `(idx + 1) % length` is safe because `THEME_CYCLE` is non-empty.
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] ?? "system";
}

/**
 * Resolve a {@link ThemeMode} into the concrete scheme that should be applied.
 *
 * For explicit modes this is the identity; `"system"` is resolved against the
 * OS via {@link resolveSystemTheme}. Pulling this out of the React provider
 * makes the system-tracking assertion in `use-theme.test.ts` trivial.
 */
export function resolveMode(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? resolveSystemTheme() : mode;
}

/**
 * Apply a mode change: persist it and return the resolved scheme.
 *
 * The provider calls this when the user invokes `setMode`. Returning the
 * resolved value (instead of just mutating storage) keeps the function pure
 * from the caller's point of view and makes the persistence-call assertion
 * straightforward in tests.
 */
export function commitMode(mode: ThemeMode): ResolvedTheme {
  writeStoredTheme(mode);
  return resolveMode(mode);
}
