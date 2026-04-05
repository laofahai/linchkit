/**
 * cap-chatter Drizzle table definitions
 *
 * All tables live in the `_linchkit` PostgreSQL schema, alongside
 * other system tables (executions, events, approvals).
 */

import { linchkitSchema } from "@linchkit/core/server";
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ── Messages table ──────────────────────────────────────────

export const messagesTable = linchkitSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }),

    // Polymorphic record reference
    entityName: varchar("entity_name", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),

    // Message classification: comment | note | log | ai
    messageType: varchar("message_type", { length: 50 }).notNull(),

    // Content
    body: text("body").notNull(),
    bodyHtml: text("body_html"),

    // Author
    authorId: varchar("author_id", { length: 255 }).notNull(),
    authorType: varchar("author_type", { length: 50 }).notNull().default("user"),
    authorName: varchar("author_name", { length: 255 }),

    // Threading
    parentId: uuid("parent_id"),
    threadCount: integer("thread_count").notNull().default(0),

    // Log-specific metadata (only for messageType = 'log')
    logEvent: varchar("log_event", { length: 255 }),
    logMetadata: jsonb("log_metadata"),

    // Soft delete
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { mode: "date" }),
    deletedBy: varchar("deleted_by", { length: 255 }),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Primary query path: messages for a record, ordered by creation time
    index("messages_record_idx").on(table.entityName, table.recordId, table.createdAt),
    // Author queries
    index("messages_author_idx").on(table.authorId),
    // Thread loading
    index("messages_parent_idx").on(table.parentId),
  ],
);
