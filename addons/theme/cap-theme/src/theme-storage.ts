/**
 * Pure read/write helpers for the persisted theme preference.
 *
 * Wrapping every `localStorage` access in `try/catch` keeps the module safe to
 * import during SSR (where `localStorage` is undefined) and in environments
 * where storage is disabled or quota-exceeded (Safari private mode, embedded
 * webviews, restrictive CSPs). The contract: malformed or unreadable values
 * are reported as `undefined` so the caller can fall back to its default
 * without crashing the render.
 *
 * Lives in its own module so it can be unit-tested without React.
 */

import { THEME_STORAGE_KEY, type ThemeMode } from "./types";

const VALID_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

/**
 * Whether `window.localStorage` is reachable in the current execution context.
 *
 * Returns `false` during SSR (no `window`) and when storage access throws
 * synchronously (Safari private mode pre-iOS 16, sandboxed iframes).
 */
function getStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read the persisted theme preference.
 *
 * @returns The stored mode, or `undefined` when nothing is stored / the value
 *   is corrupted / storage is unavailable.
 */
export function readStoredTheme(): ThemeMode | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw === null) return undefined;
    // Stored as JSON so future schema bumps (e.g. `{ mode, version }`) stay
    // backwards-compatible — the current scalar form is just a JSON string.
    const parsed: unknown = JSON.parse(raw);
    return isThemeMode(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the theme preference.
 *
 * Silently no-ops on failure (quota, disabled storage, SSR) — callers should
 * treat persistence as best-effort. The in-memory state machine remains the
 * source of truth for the current session.
 */
export function writeStoredTheme(mode: ThemeMode): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    // Intentionally swallow — see module docstring.
  }
}

/**
 * Remove the persisted theme preference. Mainly useful for tests and for a
 * future "reset to default" UI control.
 */
export function clearStoredTheme(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Intentionally swallow — see module docstring.
  }
}
