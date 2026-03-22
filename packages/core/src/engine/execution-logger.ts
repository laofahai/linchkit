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
    this.entries.push(entry);
  }

  getAll(): ExecutionLogEntry[] {
    return [...this.entries];
  }

  getByAction(action: string): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  getBySchema(schema: string): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.schema === schema);
  }

  getByStatus(status: ExecutionStatus): ExecutionLogEntry[] {
    return this.entries.filter((e) => e.status === status);
  }

  getById(id: string): ExecutionLogEntry | undefined {
    return this.entries.find((e) => e.id === id);
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
      filtered = filtered.filter((e) => e.startedAt >= since);
    }
    if (options?.until) {
      const until = new Date(options.until);
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

    // Pagination
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize);

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
