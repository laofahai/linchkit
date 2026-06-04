/**
 * Watcher debounce-state persistence collaborator (Spec 45 §4).
 *
 * Extracted from `watcher-engine.ts` to keep both files under the repo's
 * 500-line ceiling. Owns the {@link WatcherStateStore} reference and the
 * write-through "mirror" concern, while the host {@link WatcherEngine} keeps its
 * in-memory `Map` as the synchronous hot cache (its read API — `getState` /
 * `shouldFire` — is synchronous) and delegates all durable persistence here.
 *
 * Responsibilities:
 * - {@link WatcherStatePersistence.hydrate} — REPLACE a target cache map with
 *   the store's persisted entries (clears first so keys deleted from the store
 *   never linger across a `stop()`→`start()` or a re-hydrate).
 * - {@link WatcherStatePersistence.set} / `delete` / `clearForWatcher` — mirror
 *   a cache mutation to the store as a fire-and-forget write-through. Writes are
 *   serialized through a single tail promise so they apply in submission order
 *   (a slow `set` can never land after a later `delete` for the same key), yet
 *   never block the synchronous evaluation path. A store write failure — whether
 *   a SYNCHRONOUS throw or an async rejection — is logged, never propagated.
 *
 * When no store is configured the engine does not allocate this collaborator at
 * all, so behavior is byte-for-byte the historical pure-`Map` implementation.
 */

import type { Logger, WatcherStateEntry } from "@linchkit/core";
import type { WatcherStateStore } from "./watcher-state-store";

export interface WatcherStatePersistenceOptions {
  store: WatcherStateStore;
  logger: Logger;
}

/**
 * Durable mirror for the engine's in-memory debounce cache. Holds the
 * {@link WatcherStateStore} reference and serializes write-through operations so
 * they apply to the store in submission order without blocking evaluation.
 */
export class WatcherStatePersistence {
  private readonly store: WatcherStateStore;
  private readonly logger: Logger;

  /**
   * Tail of the serialized write-through chain. Each mirrored mutation appends
   * itself to this tail so writes apply to the store strictly in submission
   * order — preventing a slow earlier `set()` from landing AFTER a later
   * `delete()` for the same key and resurrecting deleted state. The chain never
   * surfaces failures to the caller (each link swallows + logs its own error).
   */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: WatcherStatePersistenceOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  /**
   * REPLACE `cache` with the store's persisted entries. The cache is cleared
   * first so any key deleted from the store does not linger in memory across a
   * `stop()`→`start()` cycle or a repeated hydrate (which would keep suppressing
   * an already-cleared watcher). A hydration failure must not crash startup — it
   * is logged and the cache is left empty (degrades to in-memory-only debounce,
   * never re-throws).
   */
  async hydrate(cache: Map<string, WatcherStateEntry>): Promise<void> {
    cache.clear();
    try {
      const entries = await this.store.load();
      for (const entry of entries) {
        cache.set(`${entry.watcherName}:${entry.groupKey}`, {
          ...entry,
          // Normalize timestamps that may arrive as strings/numbers from some
          // backends. Use a truthiness check so a store that returns `undefined`
          // (not just `null`) does not yield `new Date(undefined)` = Invalid Date.
          // A `Date` value passes through `new Date(date)` unchanged.
          lastFiredAt: entry.lastFiredAt ? new Date(entry.lastFiredAt) : null,
        });
      }
    } catch (err) {
      this.logger.error?.(
        `[WatcherEngine] Failed to hydrate debounce state from store: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Mirror an upsert of a single `(watcherName, groupKey)` to the store. */
  set(watcherName: string, groupKey: string, entry: WatcherStateEntry): void {
    this.mirror(() => this.store.set(watcherName, groupKey, { ...entry }));
  }

  /** Mirror a delete of a single `(watcherName, groupKey)` to the store. */
  delete(watcherName: string, groupKey: string): void {
    this.mirror(() => this.store.delete(watcherName, groupKey));
  }

  /** Mirror a clear of all entries for a watcher to the store. */
  clearForWatcher(watcherName: string): void {
    this.mirror(() => this.store.clearForWatcher(watcherName));
  }

  /**
   * Resolve once the serialized write chain enqueued so far has drained. Each
   * link swallows its own error, so the tail never rejects — this only signals
   * "all queued writes applied", for graceful shutdown or deterministic tests.
   */
  whenSettled(): Promise<void> {
    return this.writeTail;
  }

  /**
   * Append a store write to the serialized tail. The in-memory `Map` is the
   * synchronous source of truth for evaluation; the store is a durable mirror.
   * A store write failure — whether a SYNCHRONOUS throw from `write()` or an
   * async promise rejection — is logged but never propagated into the
   * (synchronous) evaluation path, and never breaks the chain for subsequent
   * writes. At worst the persisted state lags the cache until the next
   * successful write or restart.
   */
  private mirror(write: () => Promise<unknown> | undefined): void {
    this.writeTail = this.writeTail.then(async () => {
      try {
        await write();
      } catch (err: unknown) {
        this.logger.error?.(
          `[WatcherEngine] Failed to persist debounce state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }
}
