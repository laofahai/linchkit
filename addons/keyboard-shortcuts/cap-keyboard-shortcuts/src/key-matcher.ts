/**
 * Key matcher — parses a `keys` string into chord(s) and tests them against
 * `KeyboardEvent`-like objects.
 *
 * Platform handling: the special `Mod` modifier resolves to `Meta` on macOS
 * and `Ctrl` everywhere else. Detection is centralized in `detectPlatform()`
 * which inspects `navigator.platform` / `navigator.userAgent` and falls back
 * to `"other"` in non-browser contexts (SSR, bun test runner) so behavior is
 * deterministic. Tests inject the platform via the optional `platform`
 * parameter to avoid relying on the host environment.
 */

import type { KeyChord, KeyEventLike, Platform } from "./types";

/** Modifier-only key names that should never count as the chord's "key". */
const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "ctrl",
  "alt",
  "option",
  "meta",
  "cmd",
  "command",
  "mod",
]);

/**
 * Detect whether the current runtime is macOS / iOS. The check is intentionally
 * conservative — when there is no `navigator` (SSR, bun test, node), we return
 * `"other"` so `Mod` resolves to `Ctrl`. Callers that need explicit control
 * pass the `platform` argument directly.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const isApple = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac|iPhone|iPad|iPod/.test(userAgent);
  return isApple ? "mac" : "other";
}

/** Normalize a single token: trim + lowercase. */
function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Parse one chord string (e.g. `"Mod+Shift+K"`) into a {@link KeyChord}.
 *
 * Throws when:
 *   - the chord is empty or only modifiers (no non-modifier "key" component)
 *   - more than one non-modifier key is present (e.g. `"K+L"`)
 */
export function parseChord(chord: string, platform: Platform = detectPlatform()): KeyChord {
  const tokens = chord.split("+").map(normalizeToken).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`cap-keyboard-shortcuts: empty chord "${chord}"`);
  }

  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (const token of tokens) {
    if (token === "mod") {
      if (platform === "mac") meta = true;
      else ctrl = true;
      continue;
    }
    if (token === "meta" || token === "cmd" || token === "command") {
      meta = true;
      continue;
    }
    if (token === "ctrl" || token === "control") {
      ctrl = true;
      continue;
    }
    if (token === "alt" || token === "option") {
      alt = true;
      continue;
    }
    if (token === "shift") {
      shift = true;
      continue;
    }
    if (key !== null) {
      throw new Error(
        `cap-keyboard-shortcuts: chord "${chord}" has multiple non-modifier keys ("${key}", "${token}")`,
      );
    }
    key = token;
  }

  if (key === null) {
    throw new Error(`cap-keyboard-shortcuts: chord "${chord}" has no non-modifier key`);
  }

  return { key, meta, ctrl, alt, shift };
}

/**
 * Parse a full `keys` string into a list of chords. A single space separates
 * sequence steps; chords themselves are joined by `+`. Multiple consecutive
 * spaces collapse to one delimiter.
 */
export function parseKeys(keys: string, platform: Platform = detectPlatform()): KeyChord[] {
  const parts = keys.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`cap-keyboard-shortcuts: empty keys string "${keys}"`);
  }
  return parts.map((part) => parseChord(part, platform));
}

/**
 * Test whether a {@link KeyEventLike} matches a parsed {@link KeyChord}.
 *
 * Modifier-only events (e.g. user just pressed `Shift`) never match — we
 * require an actual non-modifier key press. The chord's modifier set must
 * match exactly (no extra, no missing modifiers).
 */
export function matchChord(chord: KeyChord, event: KeyEventLike): boolean {
  const eventKey = (event.key || "").toLowerCase();
  if (!eventKey) return false;
  if (MODIFIER_KEYS.has(eventKey)) return false;
  if (eventKey !== chord.key) return false;

  const meta = Boolean(event.metaKey);
  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  return meta === chord.meta && ctrl === chord.ctrl && alt === chord.alt && shift === chord.shift;
}

/** Human-readable serializer used by the cheatsheet ("Mod+K" → "⌘+K" / "Ctrl+K"). */
export function formatKeys(keys: string, platform: Platform = detectPlatform()): string {
  const chords = parseKeys(keys, platform);
  return chords
    .map((chord) => {
      const parts: string[] = [];
      if (chord.meta) parts.push(platform === "mac" ? "⌘" : "Meta");
      if (chord.ctrl) parts.push("Ctrl");
      if (chord.alt) parts.push(platform === "mac" ? "⌥" : "Alt");
      if (chord.shift) parts.push(platform === "mac" ? "⇧" : "Shift");
      parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : capitalize(chord.key));
      return parts.join("+");
    })
    .join(" ");
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
