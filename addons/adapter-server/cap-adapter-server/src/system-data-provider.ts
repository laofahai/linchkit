/**
 * System Data Provider
 *
 * Handles data queries for internal/system schemas that are backed by either:
 * - System tables in the `_linchkit` PostgreSQL schema (execution_log, approval)
 * - In-memory registries (rule, flow, state_machine)
 * - REST/proposal store (proposal)
 *
 * Used as a composite layer: wraps an existing DataProvider and intercepts
 * queries for internal schemas, delegating all others to the inner provider.
 */

import type {
  DataProvider,
  DataQueryOptions,
  ExecutionLogEntry,
  ExecutionLogger,
  FlowDefinition,
  RuleDefinition,
  StateDefinition,
} from "@linchkit/core";
import { approvalsTable, executionsTable } from "@linchkit/core/server";
import { and, count, eq, getTableColumns, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { INTERNAL_SCHEMA_NAMES, systemSchemas } from "./system-schemas";

// ── Types ─────────────────────────────────────────────────

interface SystemDataSources {
  db?: PostgresJsDatabase;
  rules?: RuleDefinition[];
  flows?: FlowDefinition[];
  states?: StateDefinition[];
  /** Proposals are fetched from the proposal store (REST API layer handles this) */
  proposals?: Array<Record<string, unknown>>;
  /** ExecutionLogger — used as fallback data source when db is not available */
  executionLogger?: ExecutionLogger;
}

type FilterObject = Record<string, unknown>;

// Use the canonical whitelist from system-schemas

// ── Pagination/sort meta keys (stripped from filter conditions) ──

const META_KEYS = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);

// ── JSON field serialization ─────────────────────────────

/** Pre-compute which fields are `type: "json"` for each system schema */
const JSON_FIELDS_BY_SCHEMA: Record<string, Set<string>> = {};
for (const schema of systemSchemas) {
  const jsonFields = new Set<string>();
  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (fieldDef.type === "json") {
      jsonFields.add(fieldName);
    }
  }
  if (jsonFields.size > 0) {
    JSON_FIELDS_BY_SCHEMA[schema.name] = jsonFields;
  }
}

/**
 * Serialize any `json`-typed field values that are not already strings.
 * GraphQL maps json fields to GraphQLString, so resolvers must return strings.
 */
function serializeJsonFields(
  records: Array<Record<string, unknown>>,
  schemaName: string,
): Array<Record<string, unknown>> {
  const jsonFields = JSON_FIELDS_BY_SCHEMA[schemaName];
  if (!jsonFields) return records;

  return records.map((record) => {
    let modified: Record<string, unknown> | undefined;
    for (const field of jsonFields) {
      const value = record[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        if (!modified) modified = { ...record };
        modified[field] = JSON.stringify(value);
      }
    }
    return modified ?? record;
  });
}

// ── Helpers ──────────────────────────────────────────────

function extractPagination(filter: FilterObject) {
  const page = filter.page as number | undefined;
  const pageSize = filter.pageSize as number | undefined;
  const rawOffset = filter.offset as number | undefined;
  const rawLimit = filter.limit as number | undefined;

  let offset: number | undefined;
  let limit: number | undefined;

  if (page !== undefined && pageSize !== undefined) {
    offset = (page - 1) * pageSize;
    limit = pageSize;
  } else {
    offset = rawOffset;
    limit = rawLimit;
  }

  const sortField = filter.sortField as string | undefined;
  const sortOrder = (filter.sortOrder as string | undefined) ?? "asc";

  return { offset, limit, sortField, sortOrder };
}

function extractFilterConditions(filter: FilterObject): FilterObject {
  const conditions: FilterObject = {};
  for (const [key, value] of Object.entries(filter)) {
    if (META_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    conditions[key] = value;
  }
  return conditions;
}

/** Apply in-memory filtering, sorting, and pagination to an array of records */
function applyInMemoryQuery(
  records: Array<Record<string, unknown>>,
  filter: FilterObject,
): { items: Array<Record<string, unknown>>; total: number } {
  const conditions = extractFilterConditions(filter);
  const { offset, limit, sortField, sortOrder } = extractPagination(filter);

  // Filter
  let filtered = records;
  if (Object.keys(conditions).length > 0) {
    filtered = records.filter((record) => {
      for (const [key, value] of Object.entries(conditions)) {
        if (record[key] !== value) return false;
      }
      return true;
    });
  }

  const total = filtered.length;

  // Sort
  if (sortField) {
    filtered = [...filtered].sort((a, b) => {
      const va = a[sortField];
      const vb = b[sortField];
      if (va === vb) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = va < vb ? -1 : 1;
      return sortOrder === "desc" ? -cmp : cmp;
    });
  }

  // Paginate
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : undefined;
    filtered = filtered.slice(start, end);
  }

  return { items: filtered, total };
}

// ── In-memory data transformers ─────────────────────────

function rulesToRecords(rules: RuleDefinition[]): Array<Record<string, unknown>> {
  return rules.map((r) => ({
    id: r.name,
    name: r.name,
    label: r.label ?? r.name,
    description: r.description ?? "",
    priority: r.priority ?? 0,
    trigger: r.trigger,
    condition: r.condition,
    effect_type: r.effect?.type ?? "block",
    effect: r.effect,
  }));
}

function flowsToRecords(flows: FlowDefinition[]): Array<Record<string, unknown>> {
  return flows.map((f) => ({
    id: f.name,
    name: f.name,
    label: f.label ?? f.name,
    description: f.description ?? "",
    version: f.version ?? 1,
    trigger_type: f.trigger?.type ?? "manual",
    step_count: f.steps?.length ?? 0,
    trigger: f.trigger,
    steps: f.steps,
  }));
}

function statesToRecords(states: StateDefinition[]): Array<Record<string, unknown>> {
  return states.map((s) => ({
    id: s.name,
    name: s.name,
    schema_name: s.schema,
    field: s.field,
    initial: s.initial,
    state_count: s.states?.length ?? 0,
    transition_count: s.transitions?.length ?? 0,
    states: s.states,
    meta: s.meta,
  }));
}

// ── ExecutionLogEntry → system schema record converter ────

/** Convert an ExecutionLogEntry (camelCase) to a system schema record (snake_case) */
function executionEntryToRecord(e: ExecutionLogEntry): Record<string, unknown> {
  return {
    id: e.id,
    action_name: e.action,
    schema_name: e.schema ?? null,
    record_id: e.recordId ?? null,
    capability: e.capability ?? null,
    actor_id: e.actor?.id ?? null,
    actor_type: e.actor?.type ?? null,
    status: e.status,
    duration_ms: e.duration ?? 0,
    error_code: e.error?.code ?? null,
    error_message: e.error?.message ?? null,
    channel: e.channel ?? null,
    input:
      e.input != null ? (typeof e.input === "string" ? e.input : JSON.stringify(e.input)) : null,
    output:
      e.output != null
        ? typeof e.output === "string"
          ? e.output
          : JSON.stringify(e.output)
        : null,
    started_at: e.startedAt instanceof Date ? e.startedAt.toISOString() : (e.startedAt ?? null),
    completed_at:
      e.completedAt instanceof Date ? e.completedAt.toISOString() : (e.completedAt ?? null),
    created_at:
      e.startedAt instanceof Date
        ? e.startedAt.toISOString()
        : (e.startedAt ?? new Date().toISOString()),
    updated_at:
      e.completedAt instanceof Date
        ? e.completedAt.toISOString()
        : (e.completedAt ?? new Date().toISOString()),
    parent_execution_id: e.parentExecutionId ?? null,
    idempotency_key: e.idempotencyKey ?? null,
    tenant_id: e.tenantId ?? null,
  };
}

// ── DB query helpers for system tables ───────────────────

const TABLE_MAP = {
  execution_log: executionsTable,
  approval: approvalsTable,
} as const;

/** Column name mapping: schema field name → DB column name */
const COLUMN_ALIAS: Record<string, Record<string, string>> = {
  execution_log: {
    action_name: "actionName",
    schema_name: "schemaName",
    record_id: "recordId",
    actor_id: "actorId",
    actor_type: "actorType",
    error_code: "errorCode",
    error_message: "errorMessage",
    duration_ms: "durationMs",
    started_at: "startedAt",
    completed_at: "completedAt",
    created_at: "createdAt",
    parent_execution_id: "parentExecutionId",
    idempotency_key: "idempotencyKey",
    tenant_id: "tenantId",
  },
  approval: {
    action_name: "actionName",
    schema_name: "schemaName",
    record_id: "recordId",
    actor_id: "actorId",
    actor_type: "actorType",
    assignee_type: "assigneeType",
    assignee_value: "assigneeValue",
    decided_by: "decidedBy",
    decided_at: "decidedAt",
    decision_note: "decisionNote",
    expires_at: "expiresAt",
    timeout_policy: "timeoutPolicy",
    trigger_rules: "triggerRules",
    original_execution_id: "originalExecutionId",
    execution_id: "executionId",
    execution_error: "executionError",
    created_at: "createdAt",
    updated_at: "updatedAt",
    tenant_id: "tenantId",
  },
};

/** Reverse mapping: DB column name → schema field name */
function buildReverseAlias(schemaName: string): Record<string, string> {
  const alias = COLUMN_ALIAS[schemaName];
  if (!alias) return {};
  const reverse: Record<string, string> = {};
  for (const [snakeField, camelCol] of Object.entries(alias)) {
    reverse[camelCol] = snakeField;
  }
  return reverse;
}

/** Convert a DB row (camelCase columns) to schema record (snake_case fields) */
function dbRowToRecord(row: Record<string, unknown>, schemaName: string): Record<string, unknown> {
  const reverseAlias = buildReverseAlias(schemaName);
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const fieldName = reverseAlias[key] ?? key;
    // Serialize Date objects to ISO strings for GraphQL compatibility
    record[fieldName] = value instanceof Date ? value.toISOString() : value;
  }
  return record;
}

// ── SystemDataProvider ──────────────────────────────────

export class SystemDataProvider implements DataProvider {
  constructor(
    private readonly inner: DataProvider,
    private readonly sources: SystemDataSources,
  ) {}

  /** Update in-memory data sources (e.g., when registries change) */
  updateSources(partial: Partial<SystemDataSources>): void {
    Object.assign(this.sources, partial);
  }

  private isInternal(schema: string): boolean {
    return INTERNAL_SCHEMA_NAMES.has(schema);
  }

  // ── get ──────────────────────────────────────────────

  async get(
    schema: string,
    id: string,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    if (!this.isInternal(schema)) return this.inner.get(schema, id, options);

    if (schema === "execution_log" || schema === "approval") {
      // Fallback to ExecutionLogger when DB is not available
      if (!this.sources.db && schema === "execution_log" && this.sources.executionLogger) {
        const entry = await this.sources.executionLogger.getById(id);
        if (!entry) throw new Error(`${schema} "${id}" not found`);
        return serializeJsonFields([executionEntryToRecord(entry)], schema)[0] as Record<
          string,
          unknown
        >;
      }
      return this.dbGet(schema, id);
    }

    // In-memory schemas
    const records = this.getInMemoryRecords(schema);
    const found = records.find((r) => r.id === id);
    if (!found) {
      throw new Error(`${schema} "${id}" not found`);
    }
    return found;
  }

  // ── query ────────────────────────────────────────────

  async query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.isInternal(schema)) return this.inner.query(schema, filter, options);

    if (schema === "execution_log" || schema === "approval") {
      // Fallback to ExecutionLogger when DB is not available
      if (!this.sources.db && schema === "execution_log" && this.sources.executionLogger) {
        return this.executionLoggerQuery(filter);
      }
      return this.dbQuery(schema, filter, options);
    }

    // In-memory schemas
    const records = this.getInMemoryRecords(schema);
    return applyInMemoryQuery(records, filter).items;
  }

  // ── count ────────────────────────────────────────────

  async count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number> {
    if (!this.isInternal(schema)) return this.inner.count(schema, filter, options);

    if (schema === "execution_log" || schema === "approval") {
      // Fallback to ExecutionLogger when DB is not available
      if (!this.sources.db && schema === "execution_log" && this.sources.executionLogger) {
        return this.executionLoggerCount(filter ?? {});
      }
      return this.dbCount(schema, filter ?? {}, options);
    }

    // In-memory schemas
    const records = this.getInMemoryRecords(schema);
    const conditions = extractFilterConditions(filter ?? {});
    if (Object.keys(conditions).length === 0) return records.length;
    return applyInMemoryQuery(records, filter ?? {}).total;
  }

  // ── create / update / delete (read-only for internal) ──

  async create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.isInternal(schema)) {
      throw new Error(`Cannot create records in internal schema "${schema}"`);
    }
    return this.inner.create(schema, data);
  }

  async update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    if (this.isInternal(schema)) {
      throw new Error(`Cannot update records in internal schema "${schema}"`);
    }
    return this.inner.update(schema, id, data, options);
  }

  async delete(schema: string, id: string, options?: DataQueryOptions): Promise<void> {
    if (this.isInternal(schema)) {
      throw new Error(`Cannot delete records in internal schema "${schema}"`);
    }
    return this.inner.delete(schema, id, options);
  }

  // ── In-memory record sources ─────────────────────────

  private getInMemoryRecords(schema: string): Array<Record<string, unknown>> {
    let records: Array<Record<string, unknown>>;
    switch (schema) {
      case "rule":
        records = rulesToRecords(this.sources.rules ?? []);
        break;
      case "flow":
        records = flowsToRecords(this.sources.flows ?? []);
        break;
      case "state_machine":
        records = statesToRecords(this.sources.states ?? []);
        break;
      case "proposal":
        records = this.sources.proposals ?? [];
        break;
      default:
        return [];
    }
    // Serialize json-typed fields to strings for GraphQL compatibility
    return serializeJsonFields(records, schema);
  }

  // ── ExecutionLogger fallback (no DB) ─────────────────

  /** Query execution logs from the in-memory ExecutionLogger (no-DB fallback) */
  private async executionLoggerQuery(
    filter: FilterObject,
  ): Promise<Array<Record<string, unknown>>> {
    const logger = this.sources.executionLogger;
    if (!logger) return [];

    const entries = await logger.getAll();
    const records = entries.map(executionEntryToRecord);
    const result = applyInMemoryQuery(records, filter);
    return serializeJsonFields(result.items, "execution_log");
  }

  /** Count execution logs from the in-memory ExecutionLogger (no-DB fallback) */
  private async executionLoggerCount(filter: FilterObject): Promise<number> {
    const logger = this.sources.executionLogger;
    if (!logger) return 0;

    const entries = await logger.getAll();
    const records = entries.map(executionEntryToRecord);
    const conditions = extractFilterConditions(filter);
    if (Object.keys(conditions).length === 0) return records.length;
    return applyInMemoryQuery(records, filter).total;
  }

  // ── DB query implementations ─────────────────────────

  private async dbGet(
    schema: "execution_log" | "approval",
    id: string,
  ): Promise<Record<string, unknown>> {
    const db = this.sources.db;
    if (!db) throw new Error("Database not available for system table query");

    const table = TABLE_MAP[schema];
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    // biome-ignore lint/style/noNonNullAssertion: id column always exists in system tables
    const idCol = columns.id!;
    const rows = await db.select().from(table).where(eq(idCol, id)).limit(1);
    if (rows.length === 0) {
      throw new Error(`${schema} "${id}" not found`);
    }
    const record = dbRowToRecord(rows[0] as Record<string, unknown>, schema);
    return serializeJsonFields([record], schema)[0] as Record<string, unknown>;
  }

  private async dbQuery(
    schema: "execution_log" | "approval",
    filter: FilterObject,
    _options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    const db = this.sources.db;
    if (!db) return [];

    const table = TABLE_MAP[schema];
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    const alias = COLUMN_ALIAS[schema] ?? {};
    const conditions = extractFilterConditions(filter);
    const { offset, limit, sortField, sortOrder } = extractPagination(filter);

    // Build WHERE conditions
    const whereParts = [];
    for (const [fieldName, value] of Object.entries(conditions)) {
      const colName = alias[fieldName] ?? fieldName;
      const col = columns[colName];
      if (col) {
        whereParts.push(eq(col, value));
      }
    }

    const whereClause = whereParts.length > 0 ? and(...whereParts) : undefined;

    let query = db.select().from(table);
    if (whereClause) {
      query = query.where(whereClause) as typeof query;
    }

    // Sort
    if (sortField) {
      const colName = alias[sortField] ?? sortField;
      const sortCol = columns[colName];
      if (sortCol) {
        query = query.orderBy(
          sortOrder === "desc" ? sql`${sortCol} desc` : sql`${sortCol} asc`,
        ) as typeof query;
      }
    }

    // Paginate
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    if (offset !== undefined) {
      query = query.offset(offset) as typeof query;
    }

    const rows = await query;
    const records = (rows as Array<Record<string, unknown>>).map((row) =>
      dbRowToRecord(row, schema),
    );
    return serializeJsonFields(records, schema);
  }

  private async dbCount(
    schema: "execution_log" | "approval",
    filter: FilterObject,
    _options?: DataQueryOptions,
  ): Promise<number> {
    const db = this.sources.db;
    if (!db) return 0;

    const table = TABLE_MAP[schema];
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    const alias = COLUMN_ALIAS[schema] ?? {};
    const conditions = extractFilterConditions(filter);

    const whereParts = [];
    for (const [fieldName, value] of Object.entries(conditions)) {
      const colName = alias[fieldName] ?? fieldName;
      const col = columns[colName];
      if (col) {
        whereParts.push(eq(col, value));
      }
    }

    const whereClause = whereParts.length > 0 ? and(...whereParts) : undefined;

    let query = db.select({ value: count() }).from(table);
    if (whereClause) {
      query = query.where(whereClause) as typeof query;
    }

    const result = await query;
    return result[0]?.value ?? 0;
  }
}
