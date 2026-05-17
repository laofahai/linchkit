/**
 * Public type surface for cap-keyboard-shortcuts.
 *
 * A shortcut is described by a `keys` string (e.g. `"Mod+K"`, `"Shift+/"`,
 * `"g h"` for a sequence), an optional `when` predicate and `scope` label,
 * plus a required `description` used by the cheatsheet UI.
 *
 * Keys grammar (case-insensitive token names):
 *   - `Mod` resolves to `Meta` on macOS / iOS, `Ctrl` everywhere else.
 *   - Recognized modifier tokens: `Mod`, `Meta`, `Cmd`, `Command`, `Ctrl`,
 *     `Control`, `Alt`, `Option`, `Shift`.
 *   - Non-modifier token is the "key" — typically a letter, digit, or named
 *     key (e.g. `Escape`, `Enter`, `?`, `/`).
 *   - Multiple chords separated by a single space form a sequence (e.g.
 *     `"g h"` triggers after pressing `g` then `h` within `sequenceTimeoutMs`).
 *   - A single chord may contain at most one non-modifier key.
 */

/** Shortcut identifier produced by the registry. */
export type ShortcutId = string;

/** A parsed key chord — modifiers plus a single non-modifier key. */
export interface KeyChord {
  /** Lowercased non-modifier key (e.g. "k", "/", "escape"). */
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Minimal subset of `KeyboardEvent` the matcher reads. */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Shortcut handler signature. The originating event is passed through. */
export type ShortcutHandler = (event: KeyEventLike) => void;

/**
 * Shortcut options accepted by `useShortcut`. `keys` is optional/nullable
 * to support conditional registration — `useShortcut` early-returns when
 * `keys` is falsy without ever touching the registry. Use
 * {@link RegisterShortcutOptions} when calling the registry directly.
 */
export interface ShortcutOptions {
  /**
   * Key combination(s). A single chord like `"Mod+K"` or a space-separated
   * sequence of chords like `"g h"`. See module docstring for the grammar.
   *
   * Pass `null` or `undefined` from `useShortcut` to skip registration
   * entirely — useful for conditional shortcuts (e.g. a cheatsheet trigger
   * the host has opted out of) without forcing callers to invent an
   * "unreachable" key string.
   */
  keys?: string | null;
  /** Invoked when the shortcut matches and (`when` ? `when()` : true) holds. */
  handler: ShortcutHandler;
  /** Optional predicate — when it returns false the shortcut is skipped. */
  when?: () => boolean;
  /**
   * Optional grouping label used by the cheatsheet (e.g. "Navigation").
   * Defaults to "global".
   */
  scope?: string;
  /** Human-readable description rendered in the cheatsheet. Required. */
  description: string;
  /**
   * When true, the shortcut still fires while focus is in an editable
   * element (`INPUT` / `TEXTAREA` / `SELECT` / contentEditable).
   * Default false — editable targets are bailed out as a UX safety net.
   */
  allowInInput?: boolean;
}

/**
 * Strict variant consumed by `ShortcutRegistry.register`. `keys` is required
 * here because the registry has no way to "skip" — the hook layer is the
 * place where conditional registration is decided.
 */
export interface RegisterShortcutOptions extends Omit<ShortcutOptions, "keys"> {
  keys: string;
}

/**
 * Read-only snapshot of a registered shortcut. Returned by
 * `registry.listShortcuts()` and consumed by `<ShortcutCheatsheet>`.
 */
export interface ShortcutSnapshot {
  id: ShortcutId;
  keys: string;
  scope: string;
  description: string;
  allowInInput: boolean;
  /** True when no `when` predicate is set OR the predicate currently passes. */
  enabled: boolean;
}

/** Platform tag used by the `Mod` modifier resolver. */
export type Platform = "mac" | "other";
