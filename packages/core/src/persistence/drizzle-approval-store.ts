/**
 * DrizzleApprovalStore — PostgreSQL-backed approval store via Drizzle ORM.
 *
 * Persists ApprovalRequest records to the _linchkit_approvals system table.
 */

import { and, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Actor, ActorType } from "../types/action";
import type { ApprovalQuery, ApprovalRequest, ApprovalStatus } from "../types/approval";
import { approvalsTable } from "./system-tables";

/** Full actor objects stored in JSONB to avoid lossy column mapping */
interface ApprovalMetadata {
  requestedBy?: Actor;
  decidedBy?: Actor;
}

export class DrizzleApprovalStore {
  constructor(private db: PostgresJsDatabase) {}

  async create(request: ApprovalRequest): Promise<void> {
    const metadata: ApprovalMetadata = {
      requestedBy: request.requestedBy,
      decidedBy: request.decidedBy,
    };
    await this.db.insert(approvalsTable).values({
      id: request.id,
      tenantId: request.tenantId ?? null,
      actionName: request.action,
      schemaName: request.schema ?? null,
      recordId: request.recordId ?? null,
      capability: request.capability ?? null,
      input: request.input,
      level: request.level,
      reason: request.reason,
      triggerRules: request.triggerRules,
      actorId: request.requestedBy.id,
      actorType: request.requestedBy.type,
      assigneeType: request.assignee.type,
      assigneeValue: request.assignee.value,
      status: request.status,
      decidedBy: request.decidedBy?.id ?? null,
      decidedAt: request.decidedAt ?? null,
      decisionNote: request.decisionNote ?? null,
      expiresAt: request.expiresAt ?? null,
      timeoutPolicy: request.timeoutPolicy,
      originalExecutionId: request.originalExecutionId,
      executionId: request.executionId ?? null,
      executionError: request.executionError ?? null,
      metadata,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
  }

  async getById(id: string): Promise<ApprovalRequest | undefined> {
    const rows = await this.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToRequest(row) : undefined;
  }

  async update(id: string, data: Partial<ApprovalRequest>): Promise<ApprovalRequest | undefined> {
    const existing = await this.getById(id);
    if (!existing) return undefined;

    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (data.status !== undefined) updateValues.status = data.status;
    if (data.decidedBy !== undefined) {
      updateValues.decidedBy = data.decidedBy.id;
      // Also update metadata JSONB with full Actor object
      const meta: ApprovalMetadata = {
        requestedBy: existing.requestedBy,
        decidedBy: data.decidedBy,
      };
      updateValues.metadata = meta;
    }
    if (data.decidedAt !== undefined) updateValues.decidedAt = data.decidedAt;
    if (data.decisionNote !== undefined) updateValues.decisionNote = data.decisionNote;
    if (data.executionId !== undefined) updateValues.executionId = data.executionId;
    if (data.executionError !== undefined) updateValues.executionError = data.executionError;

    await this.db.update(approvalsTable).set(updateValues).where(eq(approvalsTable.id, id));

    return this.getById(id);
  }

  async query(options?: ApprovalQuery): Promise<ApprovalRequest[]> {
    const conditions = buildConditions(options);
    const rows = await this.db
      .select()
      .from(approvalsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    return rows.map(rowToRequest);
  }

  async getExpired(): Promise<ApprovalRequest[]> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(approvalsTable)
      .where(and(eq(approvalsTable.status, "pending"), lte(approvalsTable.expiresAt, now)));
    return rows.map(rowToRequest);
  }
}

// ── Helpers ──────────────────────────────────────────────────

type ApprovalRow = typeof approvalsTable.$inferSelect;

function rowToRequest(row: ApprovalRow): ApprovalRequest {
  const meta = (row.metadata ?? {}) as ApprovalMetadata;
  const fallbackActor: Actor = {
    type: (row.actorType ?? "system") as ActorType,
    id: row.actorId ?? "unknown",
    groups: [],
  };
  return {
    id: row.id,
    action: row.actionName,
    schema: row.schemaName ?? undefined,
    recordId: row.recordId ?? undefined,
    capability: row.capability ?? undefined,
    input: (row.input as Record<string, unknown>) ?? {},
    level: row.level,
    reason: row.reason,
    triggerRules: (row.triggerRules as string[]) ?? [],
    requestedBy: meta.requestedBy ?? fallbackActor,
    assignee: { type: row.assigneeType as "role" | "user" | "group", value: row.assigneeValue },
    status: row.status as ApprovalStatus,
    decidedBy:
      meta.decidedBy ??
      (row.decidedBy ? { type: "human" as ActorType, id: row.decidedBy, groups: [] } : undefined),
    decidedAt: row.decidedAt ?? undefined,
    decisionNote: row.decisionNote ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    timeoutPolicy: (row.timeoutPolicy as ApprovalRequest["timeoutPolicy"]) ?? "reject",
    originalExecutionId: row.originalExecutionId ?? "",
    executionId: row.executionId ?? undefined,
    executionError: row.executionError ?? undefined,
    tenantId: row.tenantId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildConditions(options?: ApprovalQuery) {
  const conditions = [];
  if (options?.status) conditions.push(eq(approvalsTable.status, options.status));
  if (options?.action) conditions.push(eq(approvalsTable.actionName, options.action));
  if (options?.schema) conditions.push(eq(approvalsTable.schemaName, options.schema));
  if (options?.requestedById) conditions.push(eq(approvalsTable.actorId, options.requestedById));
  if (options?.assigneeType) conditions.push(eq(approvalsTable.assigneeType, options.assigneeType));
  if (options?.assigneeValue)
    conditions.push(eq(approvalsTable.assigneeValue, options.assigneeValue));
  if (options?.tenantId) conditions.push(eq(approvalsTable.tenantId, options.tenantId));
  return conditions;
}
