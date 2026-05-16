/**
 * Public surface for @linchkit/cap-keyboard-shortcuts.
 *
 * Host apps typically only import:
 *   - `<ShortcutProvider>` — mount once at the app root.
 *   - `useShortcut({ keys, handler, description })` — per-component.
 *   - `<ShortcutCheatsheet />` — drop-in overlay bound to Shift+? by default.
 *
 * Lower-level building blocks (registry, parsers) are also exported so
 * other capabilities can build on top of them without re-implementing
 * the matcher.
 */

export { capKeyboardShortcuts } from "./capability";
export {
  detectPlatform,
  formatKeys,
  matchChord,
  parseChord,
  parseKeys,
} from "./key-matcher";
export { ShortcutCheatsheet, type ShortcutCheatsheetProps } from "./ShortcutCheatsheet";
export {
  ShortcutProvider,
  type ShortcutProviderProps,
  useShortcutRegistry,
} from "./ShortcutProvider";
export {
  DEFAULT_SEQUENCE_TIMEOUT_MS,
  type RegistryOptions,
  ShortcutRegistry,
} from "./shortcut-registry";
export type {
  KeyChord,
  KeyEventLike,
  Platform,
  ShortcutHandler,
  ShortcutId,
  ShortcutOptions,
  ShortcutSnapshot,
} from "./types";
export { useShortcut } from "./use-shortcut";
