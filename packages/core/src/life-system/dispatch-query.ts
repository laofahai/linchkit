/**
 * Dispatch query helper — routes SensorContext queries to the right backing store.
 *
 * LinchKit runtime has two disjoint data sources:
 *   - Business DataProvider — entity rows (users, orders, purchase_requests…)
 *   - ExecutionLogger       — execution_log rows (action invocations)
 *
 * Sensors declare `ctx.query(schema, filter)` usage without knowing which backend
 * owns a given schema. This helper dispatches by schema name so sensors that look
 * at `execution_log` actually reach the logger (not the DataProvider which doesn't
 * register system tables).
 *
 * Spec 55 §3.3 — sensors query via SensorContext, routing is a runtime concern.
 */

import type { DataProvider } from "../engine/action-engine";
import type { ExecutionLogFindOptions, ExecutionLogger } from "../types/execution-log";
import type { SensorContext } from "../types/life-system";

export interface CreateDispatchQueryOptions {
  /** Business data provider for non-system schemas. */
  dataProvider: DataProvider;
  /** Execution log source for the `execution_log` schema. */
  executionLogger: ExecutionLogger;
  /**
   * Upper bound on rows pulled from the execution log per call.
   * Defaults to 1000. Sensors that need unbounded history should
   * paginate explicitly (not yet implemented — see Spec 55 roadmap).
   */
  executionLogPageSize?: number;
  /**
   * Tenant id to scope execution_log reads. When set, only log entries
   * written with a matching tenantId are returned — prevents a sensor
   * running for tenant A from observing tenant B's execution history.
   *
   * Callers running per-tenant evolution cycles should create one
   * dispatch-query instance per tenant rather than sharing a single
   * unscoped instance.
   */
  tenantId?: string;
}

const DEFAULT_EXECUTION_LOG_PAGE_SIZE = 1000;

/**
 * Build a `SensorContext["query"]` function that routes `execution_log`
 * queries to the ExecutionLogger and all other schemas to the DataProvider.
 *
 * The generic `T` cast at the boundary is intentional: sensors declare the
 * row shape they expect (e.g. `ExecutionLogEntry` fields). Runtime schema
 * validation is deliberately NOT performed here — if a sensor reads a field
 * that doesn't exist it'll get `undefined`, which is caught by unit tests.
 */
export function createDispatchQuery(
  opts: CreateDispatchQueryOptions,
): NonNullable<SensorContext["query"]> {
  const pageSize = opts.executionLogPageSize ?? DEFAULT_EXECUTION_LOG_PAGE_SIZE;

  return async <T = unknown>(schema: string, filter?: Record<string, unknown>): Promise<T[]> => {
    if (schema === "execution_log") {
      // Translate the generic equality filter into the logger's typed filter.
      // Only a subset of execution_log fields are routed today; add more as
      // sensors need them (actor_id, capability, channel, …).
      const actionName = typeof filter?.action_name === "string" ? filter.action_name : undefined;
      const entityName = typeof filter?.entity_name === "string" ? filter.entity_name : undefined;
      const statusVal = typeof filter?.status === "string" ? filter.status : undefined;

      const result = await opts.executionLogger.findMany({
        tenantId: opts.tenantId,
        action: actionName,
        entity: entityName,
        status: statusVal as ExecutionLogFindOptions["status"],
        pageSize,
      });
      return result.items as T[];
    }

    const rows = await opts.dataProvider.query(schema, filter ?? {});
    return rows as T[];
  };
}
