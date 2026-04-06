/**
 * System table: _linchkit.field_overlays
 *
 * Stores runtime field overlay definitions for entities.
 * Each row represents a dynamic field added to an entity at runtime.
 * Field data is stored in the `_extensions` JSONB column on entity tables.
 */

import { jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { linchkitSchema } from "./system-tables";

export const overlayStatusEnum = linchkitSchema.enum("overlay_status", [
  "active",
  "deprecated",
  "promoted",
]);

export const fieldOverlaysTable = linchkitSchema.table(
  "field_overlays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityName: text("entity_name").notNull(),
    fieldName: text("field_name").notNull(),
    fieldType: text("field_type").notNull(),
    config: jsonb("config").notNull().default({}),
    proposalId: uuid("proposal_id"),
    status: overlayStatusEnum("status").notNull().default("active"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_field_overlays_entity_field").on(table.entityName, table.fieldName),
  ],
);
