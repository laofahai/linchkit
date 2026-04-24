/**
 * StorageRegistry — module-level holder for the active StorageAdapter.
 *
 * The capability factory sets the adapter at construction time; actions
 * resolve it via `getStorageAdapter()` at execution time. Tests may swap
 * adapters with `setStorageAdapter()` / `resetStorageAdapter()`.
 *
 * This indirection exists because the current `ActionContext` does not yet
 * expose a generic service-injection slot (see TODO). When core adds one,
 * this module can delegate to `ctx.service("storage")` and be removed.
 */

import type { StorageAdapter } from "./adapters/storage-adapter";

let activeAdapter: StorageAdapter | undefined;

export function setStorageAdapter(adapter: StorageAdapter): void {
  activeAdapter = adapter;
}

export function getStorageAdapter(): StorageAdapter {
  if (!activeAdapter) {
    throw new Error(
      "cap-file-storage: no StorageAdapter configured. " +
        "Use createCapFileStorage({ adapter }) or call setStorageAdapter() before executing file actions.",
    );
  }
  return activeAdapter;
}

export function resetStorageAdapter(): void {
  activeAdapter = undefined;
}
