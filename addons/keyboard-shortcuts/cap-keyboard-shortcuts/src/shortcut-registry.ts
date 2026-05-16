/**
 * In-memory shortcut registry. One instance is created per
 * `<ShortcutProvider>` and lives for the lifetime of that provider.
 *
 * Responsibilities:
 *   - Track registered shortcuts (insertion-ordered for stable cheatsheet output).
 *   - Detect conflicts: two enabled handlers registered for the same
 *     normalized `keys` within the same `scope` emit a `console.warn`.
 *   - Dispatch a `KeyboardEvent` to the first matching handler — honoring
 *     the `when` predicate and the editable-target bail-out (unless
 *     `allowInInput` is set on the shortcut).
 *   - Maintain sequence state across keypresses (for chords like `"g h"`).
 */

import { matchChord, parseKeys } from "./key-matcher";
import type {
  KeyChord,
  KeyEventLike,
  Platform,
  ShortcutHandler,
  ShortcutId,
  ShortcutOptions,
  ShortcutSnapshot,
} from "./types";

/** Default window (ms) between sequence keypresses before the buffer resets. */
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000;

interface RegisteredShortcut {
  id: ShortcutId;
  keys: string;
  /** Normalized form used for conflict detection (lowercased, no spaces). */
  normalizedKeys: string;
  scope: string;
  description: string;
  allowInInput: boolean;
  when?: () => boolean;
  handler: ShortcutHandler;
  chords: KeyChord[];
}

export interface RegistryOptions {
  /** Inject a platform tag — defaults to runtime detection at parse time. */
  platform?: Platform;
  /** Override the sequence timeout window. */
  sequenceTimeoutMs?: number;
  /** Override the conflict-warning sink (defaults to `console.warn`). */
  warn?: (message: string) => void;
}

let nextId = 1;

/** Normalize a keys string for conflict detection: split on whitespace, lowercase, sort modifiers. */
function normalizeKeys(keys: string): string {
  return keys
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const tokens = chord
        .split("+")
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);
      // Stable sort so "Shift+Mod+K" === "Mod+Shift+K".
      tokens.sort();
      return tokens.join("+");
    })
    .join(" ");
}

export class ShortcutRegistry {
  private readonly shortcuts = new Map<ShortcutId, RegisteredShortcut>();
  private readonly sequenceTimeoutMs: number;
  private readonly platform: Platform | undefined;
  private readonly warn: (message: string) => void;

  /** Buffer of recently matched chords (for sequence shortcuts). */
  private sequenceBuffer: KeyChord[] = [];
  private lastEventAt = 0;

  constructor(options: RegistryOptions = {}) {
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
    this.platform = options.platform;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * Register a shortcut. Returns the assigned id — pass it to
   * `unregister()` to clean up (typically from a hook's effect cleanup).
   */
  register(options: ShortcutOptions): ShortcutId {
    const chords = parseKeys(options.keys, this.platform);
    const normalizedKeys = normalizeKeys(options.keys);
    const scope = options.scope ?? "global";
    const id = `shortcut-${nextId++}`;

    // Conflict detection — only against currently enabled handlers in same scope.
    const conflict = this.findConflict(normalizedKeys, scope);
    if (conflict) {
      this.warn(
        `cap-keyboard-shortcuts: duplicate shortcut "${options.keys}" in scope "${scope}" — ` +
          `existing handler will be shadowed by the new one ("${options.description}" vs "${conflict.description}").`,
      );
    }

    this.shortcuts.set(id, {
      id,
      keys: options.keys,
      normalizedKeys,
      scope,
      description: options.description,
      allowInInput: options.allowInInput ?? false,
      when: options.when,
      handler: options.handler,
      chords,
    });
    return id;
  }

  /** Remove a shortcut by id. No-op if the id is unknown. */
  unregister(id: ShortcutId): void {
    this.shortcuts.delete(id);
  }

  /**
   * Read-only snapshot of all registered shortcuts. Insertion order is
   * preserved so the cheatsheet rendering stays stable across re-renders.
   */
  listShortcuts(): readonly ShortcutSnapshot[] {
    return Array.from(this.shortcuts.values()).map((shortcut) => ({
      id: shortcut.id,
      keys: shortcut.keys,
      scope: shortcut.scope,
      description: shortcut.description,
      allowInInput: shortcut.allowInInput,
      enabled: shortcut.when ? safePredicate(shortcut.when) : true,
    }));
  }

  /**
   * Dispatch a keyboard event to the first matching shortcut.
   *
   * `isEditableTarget` is passed in (rather than read off `event.target`)
   * so this method stays platform-agnostic — tests don't need a DOM,
   * and `<ShortcutProvider>` performs the actual `target` inspection.
   *
   * Returns `true` if a handler was invoked.
   */
  dispatch({
    event,
    isEditableTarget = false,
    now = Date.now(),
  }: {
    event: KeyEventLike;
    isEditableTarget?: boolean;
    now?: number;
  }): boolean {
    // Reset sequence buffer if the inter-key gap exceeded the window.
    if (now - this.lastEventAt > this.sequenceTimeoutMs) {
      this.sequenceBuffer = [];
    }
    this.lastEventAt = now;

    // We don't try to match if no chord parses out of the event.
    const eventChord: KeyChord = {
      key: (event.key || "").toLowerCase(),
      meta: Boolean(event.metaKey),
      ctrl: Boolean(event.ctrlKey),
      alt: Boolean(event.altKey),
      shift: Boolean(event.shiftKey),
    };

    // Push to sequence buffer (bounded to a reasonable max so misuse can't
    // grow it unbounded — longest sensible sequence is ~5 chords).
    this.sequenceBuffer.push(eventChord);
    if (this.sequenceBuffer.length > 8) {
      this.sequenceBuffer = this.sequenceBuffer.slice(-8);
    }

    for (const shortcut of this.shortcuts.values()) {
      if (isEditableTarget && !shortcut.allowInInput) continue;
      if (shortcut.when && !safePredicate(shortcut.when)) continue;
      if (!this.matchesShortcut(shortcut, event)) continue;
      // Reset buffer on a successful match so the next sequence starts fresh.
      this.sequenceBuffer = [];
      shortcut.handler(event);
      return true;
    }
    return false;
  }

  /**
   * Test whether a shortcut matches given the latest event and the current
   * sequence buffer. Single-chord shortcuts only inspect the head chord;
   * sequence shortcuts match against the tail of the buffer.
   */
  private matchesShortcut(shortcut: RegisteredShortcut, event: KeyEventLike): boolean {
    const chords = shortcut.chords;
    if (chords.length === 1) {
      const single = chords[0];
      if (!single) return false;
      return matchChord(single, event);
    }
    // Sequence — compare tail of buffer to the full chord list.
    if (this.sequenceBuffer.length < chords.length) return false;
    const tail = this.sequenceBuffer.slice(-chords.length);
    for (let i = 0; i < chords.length; i++) {
      const expected = chords[i];
      const actual = tail[i];
      if (!expected || !actual) return false;
      // Compare chord descriptors directly so we don't re-parse.
      if (
        expected.key !== actual.key ||
        expected.meta !== actual.meta ||
        expected.ctrl !== actual.ctrl ||
        expected.alt !== actual.alt ||
        expected.shift !== actual.shift
      ) {
        return false;
      }
    }
    return true;
  }

  /** Walk current registrations looking for an enabled conflict in the same scope. */
  private findConflict(normalizedKeys: string, scope: string): RegisteredShortcut | undefined {
    for (const shortcut of this.shortcuts.values()) {
      if (shortcut.scope !== scope) continue;
      if (shortcut.normalizedKeys !== normalizedKeys) continue;
      if (shortcut.when && !safePredicate(shortcut.when)) continue;
      return shortcut;
    }
    return undefined;
  }

  /** Test helper — number of currently registered shortcuts. */
  size(): number {
    return this.shortcuts.size;
  }
}

/** Invoke a `when` predicate guarded against thrown errors. */
function safePredicate(predicate: () => boolean): boolean {
  try {
    return Boolean(predicate());
  } catch {
    return false;
  }
}
