/**
 * System tables definition
 *
 * Drizzle schema for LinchKit system tables.
 * All system tables live in the `_linchkit` PostgreSQL schema to avoid
 * collisions with capability/user-defined tables in `public`.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ── Dedicated PostgreSQL schema for system tables ─────────

export const linchkitSchema = pgSchema("_linchkit");

// ── Enums (in _linchkit schema) ───────────────────────────

export const executionStatusEnum = linchkitSchema.enum("execution_status", [
  "succeeded",
  "failed",
  "blocked",
  "pending_approval",
]);

export const eventStatusEnum = linchkitSchema.enum("event_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "dead_letter",
]);

export const approvalStatusEnum = linchkitSchema.enum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

// ── Execution log table ─────────────────────────────────────

export const executionsTable = linchkitSchema.table(
  "executions",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 255 }),
    actionName: varchar("action_name", { length: 255 }).notNull(),
    entityName: varchar("entity_name", { length: 255 }),
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
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    metadata: jsonb("metadata"),
    /** Spec 65 §9 — ExecutionMeta snapshot recorded for every execution log entry */
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_executions_action_created").on(table.actionName, table.createdAt),
    index("idx_executions_tenant").on(table.tenantId, table.createdAt),
    // Scoped to tenant: different tenants may reuse the same idempotency key
    uniqueIndex("idx_executions_idempotency_key").on(table.tenantId, table.idempotencyKey),
  ],
);

// ── Event store table ───────────────────────────────────────

export const eventsTable = linchkitSchema.table(
  "events",
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
    /**
     * Spec 65 §7 (issue #228) — ExecutionMeta snapshot from the originating
     * action, persisted so outbox retries / crash recovery can rebuild
     * `EventHandlerContext.meta` instead of starting from an empty meta.
     * Stored as the JSON form returned by `ExecutionMeta.toJSON()`.
     */
    meta: jsonb("meta"),
  },
  (table) => [
    index("idx_events_type_status").on(table.eventType, table.status),
    index("idx_events_retry").on(table.status, table.nextRetryAt),
    index("idx_events_tenant").on(table.tenantId, table.eventType),
  ],
);

// ── Approval records table ──────────────────────────────────

export const approvalsTable = linchkitSchema.table("approvals", {
  id: varchar("id", { length: 255 }).primaryKey(),
  tenantId: varchar("tenant_id", { length: 255 }),
  actionName: varchar("action_name", { length: 255 }).notNull(),
  entityName: varchar("entity_name", { length: 255 }),
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
  /**
   * Full Actor JSON snapshot for `requestedBy` / `decidedBy`, captured at
   * create/decide time so historical attribution survives even if the
   * referenced actor is later renamed or deleted. Distinct from `meta`
   * (ExecutionMeta, Spec 65) — see issue #223.
   */
  actorsSnapshot: jsonb("actors_snapshot"),
  /** Spec 65 §14 M6 — Original ExecutionMeta captured at suspend, replayed on approve(). */
  meta: jsonb("meta"),
  /**
   * Spec 65 §3.3 (#230) — Adapter-injected system keys captured at suspend
   * (e.g. MCP's `_mcp_client_id`), excluding framework-reserved keys.
   * Replayed via the trusted `systemMeta` channel on approve() so adapter
   * attribution survives across suspend / rerun.
   */
  actorSystemMeta: jsonb("actor_system_meta"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Config KV store tables ──────────────────────────────

export const configScopeEnum = linchkitSchema.enum("config_scope", [
  "global",
  "tenant",
  "department",
  "user",
]);

/**
 * _linchkit.config — runtime KV config entries (spec 42 §9.1)
 *
 * Unique constraint: (namespace, key, scope, scope_id)
 */
export const configTable = linchkitSchema.table(
  "config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: varchar("namespace", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: jsonb("value"),
    scope: configScopeEnum("scope").notNull().default("global"),
    scopeId: varchar("scope_id", { length: 255 }),
    encrypted: boolean("encrypted").notNull().default(false),
    updatedBy: varchar("updated_by", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_config_unique").on(table.namespace, table.key, table.scope, table.scopeId),
    index("idx_config_namespace").on(table.namespace),
  ],
);

/**
 * _linchkit.config_versions — version history for config entries (spec 42 §9.1)
 *
 * Each set() writes a new row here for full audit trail + rollback support.
 */
export const configVersionsTable = linchkitSchema.table(
  "config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id").notNull(),
    namespace: varchar("namespace", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: jsonb("value"),
    scope: configScopeEnum("scope").notNull().default("global"),
    scopeId: varchar("scope_id", { length: 255 }),
    version: integer("version").notNull(),
    changedBy: varchar("changed_by", { length: 255 }),
    changedAt: timestamp("changed_at", { mode: "date" }).notNull().defaultNow(),
    changeReason: text("change_reason"),
  },
  (table) => [
    index("idx_config_versions_config_id").on(table.configId),
    index("idx_config_versions_ns_key").on(table.namespace, table.key, table.scope),
  ],
);

// ── Override target type enum ───────────────────────────

export const overrideTargetTypeEnum = linchkitSchema.enum("override_target_type", [
  "rule",
  "action",
  "entity",
  "view",
  "flow",
]);

// ── Tenant overrides table (Layer 2 runtime overrides) ──

export const tenantOverridesTable = linchkitSchema.table(
  "tenant_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }).notNull(),
    /** Override target type (rule, action, schema, view, flow) */
    targetType: overrideTargetTypeEnum("target_type").notNull(),
    /** Name of the definition being overridden */
    targetName: varchar("target_name", { length: 255 }).notNull(),
    /** Partial definition to deep-merge onto the Layer 0 definition */
    definition: jsonb("definition").notNull(),
    /** Whether this override is currently active */
    enabled: boolean("enabled").notNull().default(true),
    /** Who created this override */
    createdBy: varchar("created_by", { length: 255 }),
    /** Who last updated this override */
    updatedBy: varchar("updated_by", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_tenant_overrides_unique").on(
      table.tenantId,
      table.targetType,
      table.targetName,
    ),
    index("idx_tenant_overrides_tenant").on(table.tenantId),
  ],
);
