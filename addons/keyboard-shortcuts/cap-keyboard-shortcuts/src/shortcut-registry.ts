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

import { MODIFIER_KEYS, matchChord, parseKeys } from "./key-matcher";
import type {
  KeyChord,
  KeyEventLike,
  Platform,
  RegisterShortcutOptions,
  ShortcutHandler,
  ShortcutId,
  ShortcutSnapshot,
} from "./types";

/** Default window (ms) between sequence keypresses before the buffer resets. */
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Default delay (ms) used to arbitrate between a single-key shortcut and a
 * longer sequence that shares the same prefix. When a registered sequence
 * shortcut's prefix matches the current buffer we wait this long for the
 * remaining chord(s); if none arrives the single-key shortcut fires.
 */
export const DEFAULT_SEQUENCE_PREFIX_DELAY_MS = 200;

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

/** Scheduler abstraction so tests can drive deferred dispatch deterministically. */
export interface RegistryScheduler {
  setTimeout: (handler: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface RegistryOptions {
  /** Inject a platform tag — defaults to runtime detection at parse time. */
  platform?: Platform;
  /** Override the sequence timeout window. */
  sequenceTimeoutMs?: number;
  /**
   * Override the delay before a single-key shortcut fires when a longer
   * sequence shares the same prefix. Defaults to
   * {@link DEFAULT_SEQUENCE_PREFIX_DELAY_MS}.
   */
  sequencePrefixDelayMs?: number;
  /** Override the conflict-warning sink (defaults to `console.warn`). */
  warn?: (message: string) => void;
  /** Injectable scheduler — defaults to global `setTimeout`/`clearTimeout`. */
  scheduler?: RegistryScheduler;
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

/** Bookkeeping for a single-key dispatch deferred behind a pending sequence prefix. */
interface PendingSingle {
  handle: unknown;
  shortcutId: ShortcutId;
  fire: () => void;
}

export class ShortcutRegistry {
  private readonly shortcuts = new Map<ShortcutId, RegisteredShortcut>();
  private readonly sequenceTimeoutMs: number;
  private readonly sequencePrefixDelayMs: number;
  private readonly platform: Platform | undefined;
  private readonly warn: (message: string) => void;
  private readonly scheduler: RegistryScheduler;

  /** Buffer of recently matched chords (for sequence shortcuts). */
  private sequenceBuffer: KeyChord[] = [];
  private lastEventAt = 0;
  /** Single-key dispatch waiting for a possible sequence to complete. */
  private pendingSingle: PendingSingle | null = null;

  constructor(options: RegistryOptions = {}) {
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
    this.sequencePrefixDelayMs = options.sequencePrefixDelayMs ?? DEFAULT_SEQUENCE_PREFIX_DELAY_MS;
    this.platform = options.platform;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.scheduler = options.scheduler ?? defaultScheduler();
  }

  /**
   * Register a shortcut. Returns the assigned id — pass it to
   * `unregister()` to clean up (typically from a hook's effect cleanup).
   */
  register(options: RegisterShortcutOptions): ShortcutId {
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
    // If we were waiting to fire this exact shortcut, cancel the timer.
    if (this.pendingSingle && this.pendingSingle.shortcutId === id) {
      this.scheduler.clearTimeout(this.pendingSingle.handle);
      this.pendingSingle = null;
    }
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
   * Dispatch order — for each event we resolve the highest-priority
   * outcome:
   *   1. Modifier-only events (`Ctrl`, `Shift`, etc. with no real key)
   *      are ignored entirely so they don't pollute the sequence buffer.
   *   2. If the new chord completes a registered sequence, that handler
   *      fires (any pending single-key timer is cancelled).
   *   3. Otherwise, if a registered sequence's prefix matches the buffer
   *      AND a single-chord shortcut also matches the head event, the
   *      single-chord dispatch is deferred for `sequencePrefixDelayMs`
   *      so the user gets a chance to complete the sequence.
   *   4. Otherwise the first matching single-chord shortcut fires
   *      immediately.
   *
   * Returns `true` if a handler was invoked synchronously. Deferred
   * single-key dispatches return `false` here — they fire later via the
   * injected scheduler.
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

    const eventKey = (event.key || "").toLowerCase();
    // Modifier-only keydowns (just `Ctrl`, just `Shift`, …) carry no
    // useful chord — keep them out of the buffer so they can't break
    // sequences like "Mod+K G".
    if (!eventKey || MODIFIER_KEYS.has(eventKey)) {
      return false;
    }

    const eventChord: KeyChord = {
      key: eventKey,
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

    // 1) Look for a complete sequence match (chords.length > 1). A new
    //    keypress can complete at most one such shortcut per iteration —
    //    fire the first one we find (insertion order wins on ties).
    const sequenceMatch = this.findCompletedSequence(event, isEditableTarget);
    if (sequenceMatch) {
      // Cancel any deferred single-key dispatch — the sequence wins.
      this.clearPendingSingle();
      this.sequenceBuffer = [];
      sequenceMatch.handler(event);
      return true;
    }

    // 2) Look for the first eligible single-chord match.
    const singleMatch = this.findSingleMatch(event, isEditableTarget);
    if (!singleMatch) {
      return false;
    }

    // 3) If any pending sequence prefix matches the current buffer, defer.
    if (this.hasPendingSequencePrefix(isEditableTarget)) {
      this.scheduleDeferredSingle(singleMatch, event);
      return false;
    }

    // 4) Fire the single match immediately.
    this.clearPendingSingle();
    this.sequenceBuffer = [];
    singleMatch.handler(event);
    return true;
  }

  /**
   * Find the first registered sequence (chords.length > 1) whose chord
   * list matches the tail of the current sequence buffer.
   */
  private findCompletedSequence(
    event: KeyEventLike,
    isEditableTarget: boolean,
  ): RegisteredShortcut | undefined {
    for (const shortcut of this.shortcuts.values()) {
      if (shortcut.chords.length <= 1) continue;
      if (isEditableTarget && !shortcut.allowInInput) continue;
      if (shortcut.when && !safePredicate(shortcut.when)) continue;
      if (!this.matchesShortcut(shortcut, event)) continue;
      return shortcut;
    }
    return undefined;
  }

  /** Find the first eligible single-chord (chords.length === 1) match. */
  private findSingleMatch(
    event: KeyEventLike,
    isEditableTarget: boolean,
  ): RegisteredShortcut | undefined {
    for (const shortcut of this.shortcuts.values()) {
      if (shortcut.chords.length !== 1) continue;
      if (isEditableTarget && !shortcut.allowInInput) continue;
      if (shortcut.when && !safePredicate(shortcut.when)) continue;
      if (!this.matchesShortcut(shortcut, event)) continue;
      return shortcut;
    }
    return undefined;
  }

  /**
   * True when at least one registered sequence shortcut has a chord prefix
   * that matches the current buffer but is not yet complete — i.e. the
   * user might still be in the middle of typing it.
   */
  private hasPendingSequencePrefix(isEditableTarget: boolean): boolean {
    const buffer = this.sequenceBuffer;
    if (buffer.length === 0) return false;
    for (const shortcut of this.shortcuts.values()) {
      const chords = shortcut.chords;
      if (chords.length <= 1) continue;
      // Skip ineligible sequences so we don't pointlessly defer.
      if (isEditableTarget && !shortcut.allowInInput) continue;
      if (shortcut.when && !safePredicate(shortcut.when)) continue;
      if (buffer.length >= chords.length) continue;
      let matches = true;
      for (let i = 0; i < buffer.length; i++) {
        const expected = chords[i];
        const actual = buffer[i];
        if (!expected || !actual || !chordsEqual(expected, actual)) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }

  /**
   * Park a single-chord dispatch behind a short timer so the user has a
   * chance to complete a longer sequence. A new pending dispatch replaces
   * any earlier one — only the latest single-key candidate is at stake.
   */
  private scheduleDeferredSingle(shortcut: RegisteredShortcut, event: KeyEventLike): void {
    this.clearPendingSingle();
    const targetId = shortcut.id;
    const fire = () => {
      this.pendingSingle = null;
      // The shortcut may have been unregistered or disabled while waiting.
      const current = this.shortcuts.get(targetId);
      if (!current) return;
      if (current.when && !safePredicate(current.when)) return;
      this.sequenceBuffer = [];
      current.handler(event);
    };
    const handle = this.scheduler.setTimeout(fire, this.sequencePrefixDelayMs);
    this.pendingSingle = { handle, shortcutId: targetId, fire };
  }

  /** Cancel any pending deferred single-key dispatch. */
  private clearPendingSingle(): void {
    if (!this.pendingSingle) return;
    this.scheduler.clearTimeout(this.pendingSingle.handle);
    this.pendingSingle = null;
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
      if (!chordsEqual(expected, actual)) return false;
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

/** Strict-equality comparison for two parsed chords. */
function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key === b.key &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

/** Default scheduler backed by the host's global setTimeout/clearTimeout. */
function defaultScheduler(): RegistryScheduler {
  return {
    setTimeout: (handler, delayMs) =>
      (globalThis.setTimeout as (cb: () => void, ms: number) => unknown)(handler, delayMs),
    clearTimeout: (handle) => (globalThis.clearTimeout as (handle: unknown) => void)(handle),
  };
}
