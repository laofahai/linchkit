/**
 * Execution Log type definitions
 *
 * Records every Action execution for auditing, debugging, and AI analysis.
 * M0 scope: basic fields (action, actor, input, output, status, duration).
 */

import type { Actor } from "./action";

// ── Execution status ────────────────────────────────────

export type ExecutionStatus = "succeeded" | "failed" | "blocked" | "pending_approval";

// ── Rule evaluation result (recorded in log) ────────────

export interface ExecutionRuleResult {
  rule: string;
  result: "passed" | "blocked" | "warned" | "approval_required";
  message?: string;
}

// ── State transition record ─────────────────────────────

export interface ExecutionStateTransition {
  from: string;
  to: string;
}

// ── Execution log entry ─────────────────────────────────

export interface ExecutionLogEntry {
  id: string;

  // Tenant context
  tenantId?: string;

  // What
  action: string;
  capability?: string;
  schema?: string;
  recordId?: string;

  // Who
  actor: Actor;

  // Input / Output
  input: Record<string, unknown>;
  output?: unknown;

  // Result
  status: ExecutionStatus;
  error?: {
    code?: string;
    message: string;
  };

  // Rule evaluation
  rulesEvaluated?: ExecutionRuleResult[];

  // State change
  stateTransition?: ExecutionStateTransition;

  // Tracing
  parentExecutionId?: string;
  childExecutionIds?: string[];

  // Performance
  duration: number;

  // Timestamps
  startedAt: Date;
  completedAt: Date;
}

// ── Execution log query options ──────────────────────────

export interface ExecutionLogQuery {
  tenantId?: string;
  action?: string;
  schema?: string;
  status?: ExecutionStatus;
  actorId?: string;
  /** ISO date string — entries after this time */
  since?: string;
  /** ISO date string — entries before this time */
  until?: string;
}

export interface ExecutionLogFindOptions extends ExecutionLogQuery {
  page?: number;
  pageSize?: number;
  sortField?: "startedAt" | "duration" | "action";
  sortOrder?: "asc" | "desc";
}

export interface ExecutionLogListResult {
  items: ExecutionLogEntry[];
  total: number;
}

// ── ExecutionLogger interface ───────────────────────────

export interface ExecutionLogger {
  /** Record an execution log entry */
  log(entry: ExecutionLogEntry): void | Promise<void>;

  /** Query all entries */
  getAll(): ExecutionLogEntry[];

  /** Query entries by action name */
  getByAction(action: string): ExecutionLogEntry[];

  /** Query entries by schema name */
  getBySchema(schema: string): ExecutionLogEntry[];

  /** Query entries by status */
  getByStatus(status: ExecutionStatus): ExecutionLogEntry[];

  /** Get a single entry by id */
  getById(id: string): ExecutionLogEntry | undefined;

  /** Paginated query with filters */
  findMany(options?: ExecutionLogFindOptions): ExecutionLogListResult;
}
