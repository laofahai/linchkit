/**
 * Watcher debounce-state persistence seam (Spec 45 §4).
 *
 * The {@link WatcherEngine} tracks per-`(watcherName, groupKey)` debounce state
 * (last-fired time + whether the condition is currently met). Historically this
 * lived only in an in-memory `Map`, so a process restart lost all debounce state
 * — an `once_until_reset` watcher that had already fired would fire AGAIN after a
 * restart. This module introduces a persistence seam so the engine can write its
 * debounce state through to a durable store and re-hydrate it on startup.
 *
 * The engine keeps the in-memory `Map` as a synchronous hot cache (its read API
 * — `getState` / `shouldFire` — is synchronous) and mirrors every mutation to
 * the store (write-through). On startup it loads the store back into the cache,
 * making debounce state restart-safe.
 *
 * Two implementations:
 * - {@link InMemoryWatcherStateStore} — the DEFAULT. No persistence; preserves
 *   the historical (pre-Spec-45-persistence) behavior exactly. When no store is
 *   configured the engine does not even allocate one.
 * - `DrizzleWatcherStateStore` (./watcher-state-store-drizzle.ts) — PostgreSQL,
 *   backed by the `_linchkit.watcher_state` system table.
 */

import type { WatcherStateEntry } from "@linchkit/core";

/**
 * Durable backing store for watcher debounce state.
 *
 * All methods are async so a DB-backed implementation fits; the in-memory
 * default resolves synchronously. The engine treats `set` / `delete` /
 * `clearForWatcher` as fire-and-forget write-through (errors are logged, not
 * propagated into the evaluation path), and awaits {@link load} exactly once
 * during startup hydration.
 */
export interface WatcherStateStore {
  /** Load all persisted state entries (used to hydrate the engine's hot cache). */
  load(): Promise<WatcherStateEntry[]>;

  /** Upsert the debounce state for a single `(watcherName, groupKey)`. */
  set(watcherName: string, groupKey: string, entry: WatcherStateEntry): Promise<void>;

  /** Remove the debounce state for a single `(watcherName, groupKey)`. */
  delete(watcherName: string, groupKey: string): Promise<void>;

  /** Remove all debounce state for a watcher (used by `resetState(name)`). */
  clearForWatcher(watcherName: string): Promise<void>;
}

/**
 * In-memory {@link WatcherStateStore}. Holds state in a plain `Map` keyed by
 * `${watcherName}:${groupKey}` — the same key shape the engine uses internally.
 *
 * This is the DEFAULT store. It does NOT persist across process restarts; its
 * sole purpose is to keep the persistence seam uniform so the engine code path
 * is identical whether or not a durable store is configured. When the engine is
 * constructed with no store, it skips allocation of even this — behavior is then
 * byte-for-byte the historical pure-`Map` implementation.
 */
export class InMemoryWatcherStateStore implements WatcherStateStore {
  private readonly entries = new Map<string, WatcherStateEntry>();

  private key(watcherName: string, groupKey: string): string {
    return `${watcherName}:${groupKey}`;
  }

  async load(): Promise<WatcherStateEntry[]> {
    // Return defensive copies so callers can mutate freely without disturbing
    // the stored entries (mirrors the Drizzle store, which always materializes
    // fresh objects from rows).
    return Array.from(this.entries.values(), (e) => ({ ...e }));
  }

  async set(watcherName: string, groupKey: string, entry: WatcherStateEntry): Promise<void> {
    this.entries.set(this.key(watcherName, groupKey), { ...entry });
  }

  async delete(watcherName: string, groupKey: string): Promise<void> {
    this.entries.delete(this.key(watcherName, groupKey));
  }

  async clearForWatcher(watcherName: string): Promise<void> {
    const prefix = `${watcherName}:`;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}
