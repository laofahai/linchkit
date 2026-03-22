/**
 * Execution Logger — InMemory implementation
 *
 * Records Action execution logs for auditing and debugging.
 * Production implementations will use PostgreSQL (see spec 11).
 */

import type {
  ExecutionLogEntry,
  ExecutionLogFindOptions,
  ExecutionLogger,
  ExecutionLogListResult,
  ExecutionStatus,
} from "../types/execution-log";

export class InMemoryExecutionLogger implements ExecutionLogger {
  private entries: ExecutionLogEntry[] = [];

  log(entry: ExecutionLogEntry): void {
    // Deep copy to prevent caller from mutating audit history
    this.entries.push(structuredClone(entry));
  }

  getAll(): ExecutionLogEntry[] {
    return this.entries.map((e) => structuredClone(e));
  }

  getByAction(action: string): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.action === action).map((e) => structuredClone(e));
  }

  getBySchema(schema: string): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.schema === schema).map((e) => structuredClone(e));
  }

  getByStatus(status: ExecutionStatus): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.status === status).map((e) => structuredClone(e));
  }

  getById(id: string): ExecutionLogEntry | undefined {
    const entry = this.entries.find((e) => e.id === id);
    return entry ? structuredClone(entry) : undefined;
  }

  findMany(options?: ExecutionLogFindOptions): ExecutionLogListResult {
    let filtered = [...this.entries];

    // Apply filters
    if (options?.tenantId) {
      filtered = filtered.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.action) {
      filtered = filtered.filter((e) => e.action === options.action);
    }
    if (options?.schema) {
      filtered = filtered.filter((e) => e.schema === options.schema);
    }
    if (options?.status) {
      filtered = filtered.filter((e) => e.status === options.status);
    }
    if (options?.actorId) {
      filtered = filtered.filter((e) => e.actor.id === options.actorId);
    }
    if (options?.since) {
      const since = new Date(options.since);
      if (Number.isNaN(since.getTime())) {
        throw new Error(`Invalid "since" date: ${options.since}`);
      }
      filtered = filtered.filter((e) => e.startedAt >= since);
    }
    if (options?.until) {
      const until = new Date(options.until);
      if (Number.isNaN(until.getTime())) {
        throw new Error(`Invalid "until" date: ${options.until}`);
      }
      filtered = filtered.filter((e) => e.startedAt <= until);
    }

    const total = filtered.length;

    // Sort (default: startedAt desc)
    const sortField = options?.sortField ?? "startedAt";
    const sortOrder = options?.sortOrder ?? "desc";
    filtered.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (aVal === bVal) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : 1;
      return sortOrder === "desc" ? -cmp : cmp;
    });

    // Pagination (normalize bounds)
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 20));
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize).map((e) => structuredClone(e));

    return { items, total };
  }

  /** Clear all entries (useful for testing) */
  clear(): void {
    this.entries = [];
  }

  /** Get total entry count */
  get size(): number {
    return this.entries.length;
  }
}
