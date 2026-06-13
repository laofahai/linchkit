import { graphql, throwOnErrors } from "./graphql";

export interface ExecutionLogEntry {
  id: string;
  action: string;
  entity?: string;
  recordId?: string;
  actor: { type: string; id: string };
  input?: string;
  status: "succeeded" | "failed" | "blocked" | "pending_approval";
  error?: { code?: string; message: string };
  stateTransition?: { from: string; to: string };
  duration: number;
  startedAt: string;
  completedAt: string;
}

export interface ExecutionLogListResult {
  items: ExecutionLogEntry[];
  total: number;
}

export interface StateTransitionEntry {
  from: string;
  to: string;
  action: string;
  actorId: string;
  startedAt: string;
}

export async function queryExecutionLogs(options: {
  schema?: string;
  page?: number;
  pageSize?: number;
}): Promise<ExecutionLogListResult> {
  const filter = options.schema ? JSON.stringify({ entity_name: options.schema }) : undefined;
  const query = `
    query ($filter: String, $page: Int, $pageSize: Int) {
      executionLogList(filter: $filter, page: $page, pageSize: $pageSize, sortField: "started_at", sortOrder: "desc") {
        items {
          id action_name entity_name record_id
          actor_id actor_type
          input
          state_transition_from state_transition_to
          status duration_ms started_at completed_at
          error_code error_message
        }
        total
      }
    }
  `;
  const res = await graphql<{
    executionLogList: {
      items: Array<Record<string, unknown>>;
      total: number;
    };
  }>(query, {
    filter,
    page: options.page,
    pageSize: options.pageSize,
  });
  throwOnErrors(res);
  const raw = res.data?.executionLogList ?? { items: [], total: 0 };
  // Map snake_case system schema fields to camelCase UI interface
  const items: ExecutionLogEntry[] = raw.items.map((r) => ({
    id: r.id as string,
    action: r.action_name as string,
    entity: r.entity_name as string | undefined,
    recordId: r.record_id as string | undefined,
    actor: { type: (r.actor_type as string) ?? "system", id: (r.actor_id as string) ?? "unknown" },
    input:
      r.input && typeof r.input === "object"
        ? JSON.stringify(r.input)
        : (r.input as string | undefined),
    status: r.status as ExecutionLogEntry["status"],
    error:
      r.error_code || r.error_message
        ? { code: r.error_code as string | undefined, message: (r.error_message as string) ?? "" }
        : undefined,
    stateTransition: r.state_transition_to
      ? { from: (r.state_transition_from as string) ?? "", to: r.state_transition_to as string }
      : undefined,
    duration: (r.duration_ms as number) ?? 0,
    startedAt: r.started_at as string,
    completedAt: r.completed_at as string,
  }));
  return { items, total: raw.total };
}

export async function queryStateTransitions(
  entityName: string,
  recordId: string,
): Promise<StateTransitionEntry[]> {
  const filter = JSON.stringify({ entity_name: entityName, record_id: recordId });
  const query = `
    query ($filter: String) {
      executionLogList(filter: $filter, pageSize: 50, sortField: "started_at", sortOrder: "asc") {
        items {
          action_name actor_id started_at
          state_transition_from state_transition_to
        }
      }
    }
  `;
  const res = await graphql<{
    executionLogList: {
      items: Array<Record<string, unknown>>;
    };
  }>(query, { filter });
  throwOnErrors(res);
  const items = res.data?.executionLogList?.items ?? [];
  // Only return entries that have state transition data
  return items
    .filter((r) => r.state_transition_to)
    .map((r) => ({
      from: (r.state_transition_from as string) ?? "",
      to: r.state_transition_to as string,
      action: r.action_name as string,
      actorId: (r.actor_id as string) ?? "system",
      startedAt: r.started_at as string,
    }));
}
