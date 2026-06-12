/**
 * Execution log API client — query action execution history.
 */

import { type GraphQLResponse, graphql } from "./api";

function throwOnErrors(res: GraphQLResponse): void {
  const errors = res.errors;
  if (errors && errors.length > 0) {
    const firstError = errors.at(0);
    throw new Error(firstError?.message ?? "Unknown GraphQL error");
  }
}

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

/**
 * Query execution logs for a specific schema/record via GraphQL.
 * Uses the auto-generated executionLogList query with standard filter/sort/pagination.
 */
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
          status duration_ms started_at completed_at
          error_code error_message
          state_transition_from state_transition_to
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
    stateTransition:
      r.state_transition_from || r.state_transition_to
        ? {
            from: (r.state_transition_from as string) ?? "",
            to: (r.state_transition_to as string) ?? "",
          }
        : undefined,
    duration: (r.duration_ms as number) ?? 0,
    startedAt: r.started_at as string,
    completedAt: r.completed_at as string,
  }));
  return { items, total: raw.total };
}
