/**
 * System tables definition
 *
 * Drizzle schema for LinchKit system tables.
 * All system tables use the `_linchkit_` prefix to avoid collisions
 * with capability/user-defined tables.
 */

import {
  index,
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
  "blocked",
  "pending_approval",
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
  "cancelled",
]);

// ── Execution log table ─────────────────────────────────────

export const executionsTable = pgTable(
  "_linchkit_executions",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 255 }),
    actionName: varchar("action_name", { length: 255 }).notNull(),
    schemaName: varchar("schema_name", { length: 255 }),
    recordId: varchar("record_id", { length: 255 }),
    capability: varchar("capability", { length: 255 }),
    input: jsonb("input"),
    output: jsonb("output"),
    actorId: varchar("actor_id", { length: 255 }),
    actorType: varchar("actor_type", { length: 50 }),
    status: executionStatusEnum("status").notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    channel: varchar("channel", { length: 50 }),
    parentExecutionId: varchar("parent_execution_id", { length: 255 }),
    metadata: jsonb("metadata"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_executions_action_created").on(table.actionName, table.createdAt),
    index("idx_executions_tenant").on(table.tenantId, table.createdAt),
  ],
);

// ── Event store table ───────────────────────────────────────

export const eventsTable = pgTable(
  "_linchkit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    payload: jsonb("payload"),
    sourceAction: varchar("source_action", { length: 255 }),
    sourceExecutionId: text("source_execution_id"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { mode: "date" }),
    status: eventStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    /** Number of retry attempts so far (0 = first attempt) */
    retryCount: integer("retry_count").notNull().default(0),
    /** When to next attempt processing (null = immediate or no retry scheduled) */
    nextRetryAt: timestamp("next_retry_at", { mode: "date" }),
  },
  (table) => [
    index("idx_events_type_status").on(table.eventType, table.status),
    index("idx_events_retry").on(table.status, table.nextRetryAt),
    index("idx_events_tenant").on(table.tenantId, table.eventType),
  ],
);

// ── Approval records table ──────────────────────────────────

export const approvalsTable = pgTable("_linchkit_approvals", {
  id: varchar("id", { length: 255 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 255 }),
  actionName: varchar("action_name", { length: 255 }).notNull(),
  schemaName: varchar("schema_name", { length: 255 }),
  recordId: varchar("record_id", { length: 255 }),
  capability: varchar("capability", { length: 255 }),
  input: jsonb("input"),
  level: varchar("level", { length: 100 }).notNull(),
  reason: text("reason").notNull(),
  triggerRules: jsonb("trigger_rules"),
  actorId: varchar("actor_id", { length: 255 }),
  actorType: varchar("actor_type", { length: 50 }),
  assigneeType: varchar("assignee_type", { length: 50 }).notNull(),
  assigneeValue: varchar("assignee_value", { length: 255 }).notNull(),
  status: approvalStatusEnum("status").notNull().default("pending"),
  decidedBy: varchar("decided_by", { length: 255 }),
  decidedAt: timestamp("decided_at", { mode: "date" }),
  decisionNote: text("decision_note"),
  expiresAt: timestamp("expires_at", { mode: "date" }),
  timeoutPolicy: varchar("timeout_policy", { length: 50 }).notNull().default("reject"),
  originalExecutionId: varchar("original_execution_id", { length: 255 }),
  executionId: varchar("execution_id", { length: 255 }),
  executionError: text("execution_error"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});
