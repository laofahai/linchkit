/**
 * DrizzleExecutionLogger — PostgreSQL-backed execution logger via Drizzle ORM.
 *
 * Persists ExecutionLogEntry records to the _linchkit_executions system table.
 * Complex fields (rulesEvaluated, stateTransition, childExecutionIds) are stored
 * in a JSONB metadata column.
 */

import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ActorType } from "../types/action";
import type {
  ExecutionLogEntry,
  ExecutionLogFindOptions,
  ExecutionLogListResult,
  ExecutionStatus,
} from "../types/execution-log";
import { executionsTable } from "./system-tables";

/** Metadata stored in JSONB for fields without dedicated columns */
interface ExecutionMetadata {
  actor?: ExecutionLogEntry["actor"];
  rulesEvaluated?: ExecutionLogEntry["rulesEvaluated"];
  stateTransition?: ExecutionLogEntry["stateTransition"];
  childExecutionIds?: string[];
}

export class DrizzleExecutionLogger {
  constructor(private db: PostgresJsDatabase) {}

  async log(entry: ExecutionLogEntry): Promise<void> {
    const metadata: ExecutionMetadata = {};
    metadata.actor = entry.actor;
    if (entry.rulesEvaluated) metadata.rulesEvaluated = entry.rulesEvaluated;
    if (entry.stateTransition) metadata.stateTransition = entry.stateTransition;
    if (entry.childExecutionIds?.length) metadata.childExecutionIds = entry.childExecutionIds;

    await this.db.insert(executionsTable).values({
      id: entry.id,
      tenantId: entry.tenantId ?? null,
      actionName: entry.action,
      entityName: entry.entity ?? null,
      recordId: entry.recordId ?? null,
      capability: entry.capability ?? null,
      channel: entry.channel ?? null,
      input: entry.input,
      output: entry.output ?? null,
      actorId: entry.actor.id,
      actorType: entry.actor.type,
      status: entry.status,
      errorCode: entry.error?.code ?? null,
      errorMessage: entry.error?.message ?? null,
      durationMs: entry.duration,
      parentExecutionId: entry.parentExecutionId ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      // Spec 65 §9 — ExecutionMeta snapshot. `entry.meta` is already a
      // serializable record (from `ExecutionMeta.toJSON()`); Drizzle's jsonb
      // column accepts the object directly and pg-driver handles serialization.
      meta: entry.meta ?? null,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    });
  }

  async getAll(): Promise<ExecutionLogEntry[]> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .orderBy(desc(executionsTable.startedAt));
    return rows.map(rowToEntry);
  }

  async getByAction(action: string): Promise<ExecutionLogEntry[]> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(eq(executionsTable.actionName, action))
      .orderBy(desc(executionsTable.startedAt));
    return rows.map(rowToEntry);
  }

  async getByEntity(entity: string): Promise<ExecutionLogEntry[]> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(eq(executionsTable.entityName, entity))
      .orderBy(desc(executionsTable.startedAt));
    return rows.map(rowToEntry);
  }

  async getByStatus(status: ExecutionStatus): Promise<ExecutionLogEntry[]> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(eq(executionsTable.status, status))
      .orderBy(desc(executionsTable.startedAt));
    return rows.map(rowToEntry);
  }

  async getById(id: string): Promise<ExecutionLogEntry | undefined> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(eq(executionsTable.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToEntry(row) : undefined;
  }

  async getByIdempotencyKey(key: string): Promise<ExecutionLogEntry | null> {
    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(eq(executionsTable.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    return row ? rowToEntry(row) : null;
  }

  async findMany(options?: ExecutionLogFindOptions): Promise<ExecutionLogListResult> {
    const conditions = buildConditions(options);

    // Count total
    const countResult = await this.db
      .select({ value: count() })
      .from(executionsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    const total = countResult[0]?.value ?? 0;

    // Sort
    const sortField = options?.sortField ?? "startedAt";
    const sortOrder = options?.sortOrder ?? "desc";
    const sortCol =
      sortField === "action"
        ? executionsTable.actionName
        : sortField === "duration"
          ? executionsTable.durationMs
          : executionsTable.startedAt;
    const orderFn = sortOrder === "asc" ? asc : desc;

    // Paginate
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const rows = await this.db
      .select()
      .from(executionsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderFn(sortCol))
      .limit(pageSize)
      .offset(offset);

    return { items: rows.map(rowToEntry), total };
  }
}

// ── Helpers ──────────────────────────────────────────────────

type ExecutionRow = typeof executionsTable.$inferSelect;

function rowToEntry(row: ExecutionRow): ExecutionLogEntry {
  const meta = (row.metadata ?? {}) as ExecutionMetadata;
  return {
    id: row.id,
    tenantId: row.tenantId ?? undefined,
    action: row.actionName,
    entity: row.entityName ?? undefined,
    recordId: row.recordId ?? undefined,
    capability: row.capability ?? undefined,
    input: (row.input as Record<string, unknown>) ?? {},
    output: row.output ?? undefined,
    actor: meta.actor ?? {
      type: (row.actorType ?? "system") as ActorType,
      id: row.actorId ?? "unknown",
      groups: [],
    },
    status: row.status as ExecutionStatus,
    error: row.errorMessage
      ? { code: row.errorCode ?? undefined, message: row.errorMessage }
      : undefined,
    rulesEvaluated: meta.rulesEvaluated,
    stateTransition: meta.stateTransition,
    parentExecutionId: row.parentExecutionId ?? undefined,
    childExecutionIds: meta.childExecutionIds,
    idempotencyKey: row.idempotencyKey ?? undefined,
    duration: row.durationMs ?? 0,
    startedAt: row.startedAt,
    channel: row.channel ?? undefined,
    completedAt: row.completedAt ?? undefined,
    // Spec 65 §9 — Drizzle returns jsonb columns as parsed JS objects, so we
    // pass through directly. Returning `undefined` for null keeps round-trip
    // shape parity with InMemoryExecutionLogger (which never sets meta to null).
    meta: (row.meta as Record<string, unknown> | null) ?? undefined,
  };
}

function buildConditions(options?: ExecutionLogFindOptions) {
  const conditions = [];
  if (options?.tenantId) {
    conditions.push(eq(executionsTable.tenantId, options.tenantId));
  }
  if (options?.action) {
    conditions.push(eq(executionsTable.actionName, options.action));
  }
  if (options?.entity) {
    conditions.push(eq(executionsTable.entityName, options.entity));
  }
  if (options?.status) {
    conditions.push(eq(executionsTable.status, options.status));
  }
  if (options?.actorId) {
    conditions.push(eq(executionsTable.actorId, options.actorId));
  }
  if (options?.since) {
    const since = new Date(options.since);
    if (Number.isNaN(since.getTime())) throw new Error(`Invalid "since" date: ${options.since}`);
    conditions.push(gte(executionsTable.startedAt, since));
  }
  if (options?.until) {
    const until = new Date(options.until);
    if (Number.isNaN(until.getTime())) throw new Error(`Invalid "until" date: ${options.until}`);
    conditions.push(lte(executionsTable.startedAt, until));
  }
  return conditions;
}
