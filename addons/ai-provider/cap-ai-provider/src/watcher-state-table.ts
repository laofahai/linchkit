/**
 * Watcher debounce-state system table (Spec 45 §4).
 *
 * Drizzle schema for `_linchkit.watcher_state`. Persists the per-
 * `(watcher_name, group_key)` debounce state so it survives process restarts.
 *
 * Follows the `_linchkit` system-schema convention used by the other
 * addon-owned system tables (e.g. `_linchkit.mcp_clients` in
 * `addons/adapter-mcp/cap-adapter-mcp/src/system-tables.ts` and
 * `_linchkit.search_documents` in `addons/search/cap-search/src/tables.ts`).
 * All DDL is delegated to drizzle-kit — this declaration is the single source
 * of truth. Like those peers, this table is provisioned via `db:push`, NOT the
 * core migration chain (`drizzle/migrations/` is core-schema only).
 */

import { boolean, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Reference to the shared `_linchkit` PostgreSQL schema. */
const linchkitSchema = pgSchema("_linchkit");

/**
 * Watcher debounce state — `_linchkit.watcher_state`.
 *
 * Primary key is the composite `(watcher_name, group_key)`, mirroring the
 * engine's in-memory key (`${watcherName}:${groupKey}`). `updated_at` is
 * server-managed (defaults to `now()` and is overwritten on every write).
 */
export const watcherStateTable = linchkitSchema.table(
  "watcher_state",
  {
    /** Watcher identifier (matches `WatcherDefinition.name`). */
    watcherName: text("watcher_name").notNull(),
    /** Per-record / per-group debounce key. */
    groupKey: text("group_key").notNull(),
    /** Last time the watcher fired for this group (null if it has not fired). */
    lastFiredAt: timestamp("last_fired_at", { mode: "date" }),
    /** Whether the condition is currently met for this group. */
    conditionMet: boolean("condition_met").notNull().default(false),
    /** Optional tenant scope (mirrors `WatcherStateEntry.tenantId`). */
    tenantId: text("tenant_id"),
    /** Server-managed last-write timestamp. */
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.watcherName, table.groupKey] })],
);
