/**
 * In-process LifecycleMemoryStore implementation for the life-system demo.
 *
 * Stores values in a plain Map keyed by string. Honours the `ttlMs` write
 * option by stamping an `expiresAt` field; expired entries are filtered
 * out of `read()` and `list()` lazily so we never need a sweeper timer.
 *
 * Intentionally tiny — production stores live in dedicated capabilities
 * (e.g. cap-memory-drizzle). This implementation exists so the
 * Sense -> Memory pipeline can run end-to-end without external deps.
 */

import type {
  LifecycleMemoryStore,
  MemoryStoreListOptions,
  MemoryStoreListPage,
  MemoryStoreWriteOptions,
} from "@linchkit/core";

interface Entry {
  value: unknown;
  expiresAt?: number;
}

export class InMemoryLifecycleStore implements LifecycleMemoryStore {
  private readonly entries = new Map<string, Entry>();

  async read(key: string): Promise<unknown | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async write(key: string, value: unknown, options?: MemoryStoreWriteOptions): Promise<void> {
    const ttl = options?.ttlMs;
    const expiresAt = typeof ttl === "number" ? Date.now() + ttl : undefined;
    this.entries.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(prefix?: string, options?: MemoryStoreListOptions): Promise<MemoryStoreListPage> {
    // Drop expired entries lazily so list() never returns stale keys.
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) this.entries.delete(key);
    }

    const allKeys = Array.from(this.entries.keys())
      .filter((k) => (prefix ? k.startsWith(prefix) : true))
      .sort();

    // Cursor is an opaque token — we encode it as the offset into `allKeys`.
    const offset = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const limit = options?.limit ?? allKeys.length;
    const slice = allKeys.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < allKeys.length;

    return {
      keys: slice,
      nextCursor: hasMore ? String(nextOffset) : undefined,
    };
  }

  /** Test helper — total non-expired entry count. */
  size(): number {
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) this.entries.delete(key);
    }
    return this.entries.size;
  }

  private isExpired(entry: Entry): boolean {
    return typeof entry.expiresAt === "number" && entry.expiresAt <= Date.now();
  }
}
