/**
 * MCP Client system table definition
 *
 * Drizzle schema for the _linchkit.mcp_clients table.
 * Follows the pattern from packages/core/src/persistence/system-tables.ts.
 */

import { boolean, jsonb, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Reference to the shared _linchkit PostgreSQL schema */
const linchkitSchema = pgSchema("_linchkit");

/** MCP client registrations — _linchkit.mcp_clients */
export const mcpClientsTable = linchkitSchema.table(
  "mcp_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    clientId: text("client_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    actorType: text("actor_type").notNull().default("ai"),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    actorGroups: jsonb("actor_groups").notNull().default(["ai_agent"]),
    toolPolicy: jsonb("tool_policy").notNull().default({ mode: "allow_all", tools: [] }),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_mcp_clients_client_id").on(table.clientId)],
);
