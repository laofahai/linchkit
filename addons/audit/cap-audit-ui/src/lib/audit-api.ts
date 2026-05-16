/**
 * Audit log API client.
 *
 * Wraps the existing `executionLogList` GraphQL query with a typed,
 * filter-aware helper for the audit viewer UI. Reads only — audit data
 * lives in `_linchkit.executions` and is exposed read-only via the
 * `execution_log` system entity registered by cap-adapter-server.
 *
 * NOTE: list fields here are kept tight (only what the table renders);
 * detail view issues a second targeted query for the full payload to
 * avoid shipping JSON blobs in the list payload.
 */

import { graphql } from "@linchkit/cap-adapter-ui/lib/api";

// ── Status enum ─────────────────────────────────────────

export type AuditStatus = "succeeded" | "failed" | "blocked" | "pending_approval";

export const AUDIT_STATUSES: readonly AuditStatus[] = [
  "succeeded",
  "failed",
  "blocked",
  "pending_approval",
] as const;

// ── Filter shape ────────────────────────────────────────

export interface AuditFilters {
  /** Filter by action name (exact match on action_name). */
  action?: string;
  /** Filter by actor id (exact match on actor_id). */
  actorId?: string;
  /** Filter by execution status. */
  status?: AuditStatus;
  /** Filter by entity name (exact match on entity_name). */
  entity?: string;
  /** ISO timestamp — entries started at or after this instant. */
  startedAfter?: string;
  /** ISO timestamp — entries started at or before this instant. */
  startedBefore?: string;
}

// ── Row shape used by the list view ─────────────────────

export interface AuditRow {
  id: string;
  action: string;
  entity: string | null;
  recordId: string | null;
  actorId: string | null;
  actorType: string | null;
  status: AuditStatus;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AuditListResult {
  items: AuditRow[];
  total: number;
}

// ── Detail shape ────────────────────────────────────────

export interface AuditDetail extends AuditRow {
  capability: string | null;
  channel: string | null;
  input: unknown;
  output: unknown;
  meta: Record<string, unknown> | null;
  stateTransitionFrom: string | null;
  stateTransitionTo: string | null;
}

// ── Filter serialization ───────────────────────────────

/**
 * Build the `filter` JSON string consumed by the auto-generated
 * `executionLogList` query. The server-side filter is conjunctive
 * (AND across keys).
 *
 * Empty / undefined values are dropped so the resulting filter is
 * minimal — this matches how `cap-adapter-ui/lib/api`'s
 * `queryExecutionLogs` builds its filter argument.
 *
 * Date-range note: `startedAfter` / `startedBefore` are intentionally
 * dropped here. `SystemDataProvider` currently applies filters with
 * equality only (`eq(col, value)`); serializing a `{ gte, lte }` shape
 * would silently return zero rows. Once the provider gains range-operator
 * support these branches can be re-enabled (the UI fields stay so the
 * shape of the page doesn't change when the server side lands).
 */
export function buildAuditFilter(filters: AuditFilters): string | undefined {
  const filter: Record<string, unknown> = {};
  if (filters.action) filter.action_name = filters.action;
  if (filters.actorId) filter.actor_id = filters.actorId;
  if (filters.status) filter.status = filters.status;
  if (filters.entity) filter.entity_name = filters.entity;
  return Object.keys(filter).length > 0 ? JSON.stringify(filter) : undefined;
}

// ── List query ──────────────────────────────────────────

const LIST_QUERY = `
  query AuditList($filter: String, $page: Int, $pageSize: Int, $sortField: String, $sortOrder: String) {
    executionLogList(
      filter: $filter
      page: $page
      pageSize: $pageSize
      sortField: $sortField
      sortOrder: $sortOrder
    ) {
      items {
        id action_name entity_name record_id
        actor_id actor_type
        status duration_ms
        error_code error_message
        started_at completed_at
      }
      total
    }
  }
`;

interface ListRow {
  id: string;
  action_name: string;
  entity_name: string | null;
  record_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  status: AuditStatus;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

function rowToAudit(r: ListRow): AuditRow {
  return {
    id: r.id,
    action: r.action_name,
    entity: r.entity_name,
    recordId: r.record_id,
    actorId: r.actor_id,
    actorType: r.actor_type,
    status: r.status,
    durationMs: r.duration_ms ?? 0,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export interface QueryAuditListOptions {
  filters?: AuditFilters;
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortOrder?: "asc" | "desc";
}

/**
 * Fetch a page of audit entries from `executionLogList`.
 *
 * Defaults: page 1, pageSize 50, newest-first by `started_at`.
 */
export async function queryAuditList(
  options: QueryAuditListOptions = {},
): Promise<AuditListResult> {
  const filter = buildAuditFilter(options.filters ?? {});
  const res = await graphql<{
    executionLogList: { items: ListRow[]; total: number };
  }>(LIST_QUERY, {
    filter,
    page: options.page ?? 1,
    pageSize: options.pageSize ?? 50,
    sortField: options.sortField ?? "started_at",
    sortOrder: options.sortOrder ?? "desc",
  });

  if (res.errors && res.errors.length > 0) {
    const first = res.errors.at(0);
    throw new Error(first?.message ?? "Failed to query audit log");
  }

  const data = res.data?.executionLogList ?? { items: [], total: 0 };
  return {
    items: data.items.map(rowToAudit),
    total: data.total,
  };
}

// ── Detail query ────────────────────────────────────────

const DETAIL_QUERY = `
  query AuditDetail($filter: String) {
    executionLogList(filter: $filter, page: 1, pageSize: 1) {
      items {
        id action_name entity_name record_id capability channel
        actor_id actor_type
        status duration_ms
        error_code error_message
        input output meta
        started_at completed_at
      }
    }
  }
`;

interface DetailRow extends ListRow {
  capability: string | null;
  channel: string | null;
  input: unknown;
  output: unknown;
  meta: unknown;
}

/**
 * State transition (from / to action) is persisted inside the executions
 * `metadata` JSONB under `stateTransition` rather than as top-level columns.
 * Project the values out of the parsed meta payload.
 */
function extractStateTransition(meta: unknown): { from: string | null; to: string | null } {
  if (meta && typeof meta === "object") {
    const t = (meta as { stateTransition?: { from?: unknown; to?: unknown } }).stateTransition;
    if (t && typeof t === "object") {
      const from = typeof t.from === "string" ? t.from : null;
      const to = typeof t.to === "string" ? t.to : null;
      return { from, to };
    }
  }
  return { from: null, to: null };
}

/**
 * Parse a JSON-string field returned by the auto-generated entity
 * GraphQL layer. The `system-data-provider` JSON-encodes the `input`,
 * `output`, and `meta` fields before returning them so the GraphQL
 * type can be `String`. This helper safely re-parses them — falling
 * back to the raw value if it's already an object or unparsable.
 *
 * TODO(spec-14): once the audit GraphQL type exposes typed payloads
 * directly (instead of stringified JSON), drop this helper.
 */
function parseJsonField(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Fetch a single execution by id, including the full input/output/meta
 * payload and state transition. Returns `null` if not found.
 */
export async function queryAuditDetail(id: string): Promise<AuditDetail | null> {
  const filter = JSON.stringify({ id });
  const res = await graphql<{
    executionLogList: { items: DetailRow[] };
  }>(DETAIL_QUERY, { filter });

  if (res.errors && res.errors.length > 0) {
    const first = res.errors.at(0);
    throw new Error(first?.message ?? "Failed to query audit detail");
  }

  const row = res.data?.executionLogList?.items.at(0);
  if (!row) return null;

  const meta = parseJsonField(row.meta) as Record<string, unknown> | null;
  const transition = extractStateTransition(meta);

  return {
    ...rowToAudit(row),
    capability: row.capability,
    channel: row.channel,
    input: parseJsonField(row.input),
    output: parseJsonField(row.output),
    meta,
    stateTransitionFrom: transition.from,
    stateTransitionTo: transition.to,
  };
}
