/**
 * DrizzleWatcherStateStore — PostgreSQL-backed {@link WatcherStateStore}.
 *
 * Persists watcher debounce state to the `_linchkit.watcher_state` system table
 * so it survives process restarts (Spec 45 §4). All queries are parameterized
 * via Drizzle's query builder; no raw user input is interpolated.
 */

import type { WatcherStateEntry } from "@linchkit/core";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WatcherStateStore } from "./watcher-state-store";
import { watcherStateTable } from "./watcher-state-table";

/** Map a Drizzle row to a {@link WatcherStateEntry} domain object. */
function rowToEntry(row: typeof watcherStateTable.$inferSelect): WatcherStateEntry {
  return {
    watcherName: row.watcherName,
    groupKey: row.groupKey,
    lastFiredAt: row.lastFiredAt ?? null,
    conditionMet: row.conditionMet,
    ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
  };
}

export class DrizzleWatcherStateStore implements WatcherStateStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async load(): Promise<WatcherStateEntry[]> {
    const rows = await this.db.select().from(watcherStateTable);
    return rows.map(rowToEntry);
  }

  async set(watcherName: string, groupKey: string, entry: WatcherStateEntry): Promise<void> {
    const now = new Date();
    await this.db
      .insert(watcherStateTable)
      .values({
        watcherName,
        groupKey,
        lastFiredAt: entry.lastFiredAt ?? null,
        conditionMet: entry.conditionMet,
        tenantId: entry.tenantId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [watcherStateTable.watcherName, watcherStateTable.groupKey],
        set: {
          lastFiredAt: entry.lastFiredAt ?? null,
          conditionMet: entry.conditionMet,
          tenantId: entry.tenantId ?? null,
          updatedAt: now,
        },
      });
  }

  async delete(watcherName: string, groupKey: string): Promise<void> {
    await this.db
      .delete(watcherStateTable)
      .where(
        and(
          eq(watcherStateTable.watcherName, watcherName),
          eq(watcherStateTable.groupKey, groupKey),
        ),
      );
  }

  async clearForWatcher(watcherName: string): Promise<void> {
    await this.db.delete(watcherStateTable).where(eq(watcherStateTable.watcherName, watcherName));
  }
}
