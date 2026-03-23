/**
 * DrizzleExecutionLogger — PostgreSQL-backed execution logger via Drizzle ORM.
 *
 * Persists ExecutionLogEntry records to the _linchkit_executions system table.
 * Complex fields (rulesEvaluated, stateTransition, childExecutionIds) are stored
 * in a JSONB metadata column.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, count, desc, asc, eq, gte, lte } from "drizzle-orm";
import type {
	ExecutionLogEntry,
	ExecutionLogFindOptions,
	ExecutionLogListResult,
	ExecutionStatus,
} from "../types/execution-log";
import type { ActorType } from "../types/action";
import { executionsTable } from "./system-tables";

/** Metadata stored in JSONB for fields without dedicated columns */
interface ExecutionMetadata {
	rulesEvaluated?: ExecutionLogEntry["rulesEvaluated"];
	stateTransition?: ExecutionLogEntry["stateTransition"];
	childExecutionIds?: string[];
}

export class DrizzleExecutionLogger {
	constructor(private db: PostgresJsDatabase) {}

	async log(entry: ExecutionLogEntry): Promise<void> {
		const metadata: ExecutionMetadata = {};
		if (entry.rulesEvaluated) metadata.rulesEvaluated = entry.rulesEvaluated;
		if (entry.stateTransition) metadata.stateTransition = entry.stateTransition;
		if (entry.childExecutionIds?.length) metadata.childExecutionIds = entry.childExecutionIds;

		await this.db.insert(executionsTable).values({
			id: entry.id,
			tenantId: entry.tenantId ?? null,
			actionName: entry.action,
			schemaName: entry.schema ?? null,
			recordId: entry.recordId ?? null,
			capability: entry.capability ?? null,
			input: entry.input,
			output: entry.output ?? null,
			actorId: entry.actor.id,
			actorType: entry.actor.type,
			status: entry.status,
			errorCode: entry.error?.code ?? null,
			errorMessage: entry.error?.message ?? null,
			durationMs: entry.duration,
			parentExecutionId: entry.parentExecutionId ?? null,
			metadata: Object.keys(metadata).length > 0 ? metadata : null,
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

	async getBySchema(schema: string): Promise<ExecutionLogEntry[]> {
		const rows = await this.db
			.select()
			.from(executionsTable)
			.where(eq(executionsTable.schemaName, schema))
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
		const sortCol = sortField === "action"
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
		schema: row.schemaName ?? undefined,
		recordId: row.recordId ?? undefined,
		capability: row.capability ?? undefined,
		input: (row.input as Record<string, unknown>) ?? {},
		output: row.output ?? undefined,
		actor: { type: (row.actorType ?? "system") as ActorType, id: row.actorId ?? "unknown", groups: [] },
		status: row.status as ExecutionStatus,
		error: row.errorMessage
			? { code: row.errorCode ?? undefined, message: row.errorMessage }
			: undefined,
		rulesEvaluated: meta.rulesEvaluated,
		stateTransition: meta.stateTransition,
		parentExecutionId: row.parentExecutionId ?? undefined,
		childExecutionIds: meta.childExecutionIds,
		duration: row.durationMs ?? 0,
		startedAt: row.startedAt,
		completedAt: row.completedAt ?? row.startedAt,
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
	if (options?.schema) {
		conditions.push(eq(executionsTable.schemaName, options.schema));
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
