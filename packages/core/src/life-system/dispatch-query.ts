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
   * Tenant scope for BUSINESS reads through the returned query (Spec 55 §7, #500).
   * When set, business reads pass it as `DataQueryOptions.tenantId` — the
   * canonical, provider-enforced isolation mechanism (Drizzle adds
   * `WHERE tenant_id = …` when the table has a tenant column, and no-ops for
   * tenant-agnostic tables; InMemoryStore filters likewise). When unset
   * (single-tenant / dev), reads are unscoped exactly as before — no change.
   *
   * NOT applied to `execution_log` yet: its writer (ActionEngine.logExecution)
   * does not populate `ExecutionLogEntry.tenantId`, so filtering would hand
   * sensors an empty history — deferred to #503. A set-but-blank value is
   * rejected at construction (it would read globally with current backends).
   *
   * Build one dispatch query PER tenant scope (see the runtime's `queryFactory`)
   * so a per-tenant evolution cycle cannot observe another tenant's business data.
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

  // Reject a set-but-blank tenantId. The real backends (DrizzleDataProvider,
  // InMemoryStore, execution loggers) apply the tenant filter only when the
  // value is TRUTHY, so an empty/whitespace tenantId would silently read
  // GLOBALLY (fail-open) at this security boundary. Real callers never produce
  // one — resolveRequestTenantId returns undefined for a blank header, and
  // EVOLUTION_CADENCE_TENANT_IDS trims+drops empties — so this only guards
  // against a misconfigured custom resolver, failing LOUD instead of leaking.
  // Pass `undefined` to intentionally run an unscoped (single-tenant/dev) cycle.
  if (opts.tenantId !== undefined && opts.tenantId.trim() === "") {
    throw new Error(
      "createDispatchQuery: tenantId must be a non-empty string or undefined " +
        "(received an empty/blank value, which would read across all tenants). " +
        "Pass undefined for an intentionally unscoped single-tenant/dev cycle.",
    );
  }

  return async <T = unknown>(schema: string, filter?: Record<string, unknown>): Promise<T[]> => {
    if (schema === "execution_log") {
      // Translate the generic equality filter into the logger's typed filter.
      // Only a subset of execution_log fields are routed today; add more as
      // sensors need them (actor_id, capability, channel, …).
      const actionName = typeof filter?.action_name === "string" ? filter.action_name : undefined;
      const entityName = typeof filter?.entity_name === "string" ? filter.entity_name : undefined;
      const statusVal = typeof filter?.status === "string" ? filter.status : undefined;

      // NOTE: execution_log is intentionally NOT tenant-filtered yet (#503).
      // ActionEngine.logExecution does not populate ExecutionLogEntry.tenantId,
      // so a `findMany({ tenantId })` here would match nothing and silently hand
      // tenant-scoped sensors an EMPTY action history — worse than the current
      // (unscoped) read. Scoping execution_log requires first threading the
      // tenant id onto the log WRITER; tracked in #503. Business reads below ARE
      // tenant-scoped (their rows carry tenant_id and providers enforce it).
      const result = await opts.executionLogger.findMany({
        action: actionName,
        entity: entityName,
        status: statusVal as ExecutionLogFindOptions["status"],
        pageSize,
      });
      return result.items as T[];
    }

    // Pass the tenant scope as DataQueryOptions so the provider enforces
    // isolation (`WHERE tenant_id = …`); omit options entirely when unscoped.
    // `opts.tenantId` is here either undefined (unscoped) or a validated
    // non-empty string (blank values were rejected at construction), so the
    // provider's truthy tenant check scopes correctly.
    const rows = await opts.dataProvider.query(
      schema,
      filter ?? {},
      opts.tenantId !== undefined ? { tenantId: opts.tenantId } : undefined,
    );
    return rows as T[];
  };
}
