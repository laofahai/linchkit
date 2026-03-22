/**
 * System tables definition
 *
 * Drizzle schema for LinchKit system tables.
 * All system tables use the `_linchkit_` prefix to avoid collisions
 * with capability/user-defined tables.
 */

import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ── Enums ───────────────────────────────────────────────────

export const executionStatusEnum = pgEnum("_linchkit_execution_status", [
  "succeeded",
  "failed",
  "rejected",
]);

export const eventStatusEnum = pgEnum("_linchkit_event_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const approvalStatusEnum = pgEnum("_linchkit_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

// ── Execution log table ─────────────────────────────────────

export const executionsTable = pgTable("_linchkit_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionName: varchar("action_name", { length: 255 }).notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  actorId: varchar("actor_id", { length: 255 }),
  actorType: varchar("actor_type", { length: 50 }),
  status: executionStatusEnum("status").notNull(),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  channel: varchar("channel", { length: 50 }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Event store table ───────────────────────────────────────

export const eventsTable = pgTable("_linchkit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: varchar("event_type", { length: 255 }).notNull(),
  payload: jsonb("payload"),
  sourceAction: varchar("source_action", { length: 255 }),
  sourceExecutionId: uuid("source_execution_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { mode: "date" }),
  status: eventStatusEnum("status").notNull().default("pending"),
});

// ── Approval records table ──────────────────────────────────

export const approvalsTable = pgTable("_linchkit_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionName: varchar("action_name", { length: 255 }).notNull(),
  input: jsonb("input"),
  actorId: varchar("actor_id", { length: 255 }),
  status: approvalStatusEnum("status").notNull().default("pending"),
  decidedBy: varchar("decided_by", { length: 255 }),
  decidedAt: timestamp("decided_at", { mode: "date" }),
  expiresAt: timestamp("expires_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});
