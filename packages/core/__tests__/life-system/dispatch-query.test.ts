/**
 * Tests for createDispatchQuery — runtime query routing.
 *
 * Verifies that `execution_log` queries reach ExecutionLogger while all
 * other schemas are delegated to the business DataProvider. Without this
 * split, sensors querying `execution_log` silently return 0 rows.
 */

import { describe, expect, test } from "bun:test";
import type { DataProvider, DataQueryOptions } from "../../src/engine/action-engine";
import { createDispatchQuery } from "../../src/life-system/dispatch-query";
import type {
  ExecutionLogEntry,
  ExecutionLogFindOptions,
  ExecutionLogger,
  ExecutionLogListResult,
} from "../../src/types/execution-log";

interface ExecutionLoggerCall {
  options?: ExecutionLogFindOptions;
}

interface DataProviderCall {
  schema: string;
  filter: Record<string, unknown>;
  options?: DataQueryOptions;
}

function makeExecutionLogger(items: ExecutionLogEntry[]): {
  logger: ExecutionLogger;
  calls: ExecutionLoggerCall[];
} {
  const calls: ExecutionLoggerCall[] = [];
  const logger: ExecutionLogger = {
    log: () => {},
    getAll: () => items,
    getByAction: (action) => items.filter((i) => i.action === action),
    getByEntity: (entity) => items.filter((i) => i.entity === entity),
    getByStatus: (status) => items.filter((i) => i.status === status),
    getById: (id) => items.find((i) => i.id === id),
    findMany: (options) => {
      calls.push({ options });
      const result: ExecutionLogListResult = {
        items,
        total: items.length,
        page: 1,
        pageSize: options?.pageSize ?? items.length,
      };
      return result;
    },
  };
  return { logger, calls };
}

function makeDataProvider(rows: Array<Record<string, unknown>>): {
  provider: DataProvider;
  calls: DataProviderCall[];
} {
  const calls: DataProviderCall[] = [];
  const provider: DataProvider = {
    async get() {
      throw new Error("not used in test");
    },
    async query(schema, filter, options) {
      calls.push({ schema, filter, options });
      return rows;
    },
    async create() {
      throw new Error("not used in test");
    },
    async update() {
      throw new Error("not used in test");
    },
    async delete() {
      throw new Error("not used in test");
    },
    async count() {
      return rows.length;
    },
  };
  return { provider, calls };
}

function makeExecutionLogEntry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
  return {
    id: "exec-1",
    action: "reject_purchase_request",
    entity: "purchase_request",
    status: "succeeded",
    startedAt: new Date("2026-04-10T00:00:00Z"),
    completedAt: new Date("2026-04-10T00:00:01Z"),
    ...overrides,
  };
}

describe("createDispatchQuery", () => {
  test("routes execution_log queries to ExecutionLogger (not DataProvider)", async () => {
    const entry = makeExecutionLogEntry();
    const { logger, calls: loggerCalls } = makeExecutionLogger([entry]);
    const { provider, calls: providerCalls } = makeDataProvider([]);

    const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

    const rows = await query<ExecutionLogEntry>("execution_log", {
      action_name: "reject_purchase_request",
      status: "succeeded",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("exec-1");
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0]?.options).toMatchObject({
      action: "reject_purchase_request",
      status: "succeeded",
    });
    expect(providerCalls).toHaveLength(0);
  });

  test("routes non-system queries to DataProvider (not ExecutionLogger)", async () => {
    const businessRow = { id: "pr-1", title: "Buy pencils" };
    const { logger, calls: loggerCalls } = makeExecutionLogger([]);
    const { provider, calls: providerCalls } = makeDataProvider([businessRow]);

    const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

    const rows = await query("purchase_request", { status: "draft" });

    expect(rows).toEqual([businessRow]);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      schema: "purchase_request",
      filter: { status: "draft" },
    });
    // No tenant scope configured → no DataQueryOptions passed.
    expect(providerCalls[0]?.options).toBeUndefined();
    expect(loggerCalls).toHaveLength(0);
  });

  test("translates entity_name filter to ExecutionLogger's `entity` field", async () => {
    const { logger, calls } = makeExecutionLogger([]);
    const { provider } = makeDataProvider([]);
    const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

    await query("execution_log", { entity_name: "purchase_request" });

    expect(calls[0]?.options).toMatchObject({ entity: "purchase_request" });
  });

  test("ignores non-string filter values safely", async () => {
    const { logger, calls } = makeExecutionLogger([]);
    const { provider } = makeDataProvider([]);
    const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

    await query("execution_log", {
      action_name: 42, // not a string — must be dropped, not crash
      status: true, // not a string — must be dropped
    });

    expect(calls[0]?.options).toMatchObject({
      action: undefined,
      status: undefined,
    });
  });

  test("passes empty filter to DataProvider when none supplied", async () => {
    const { logger } = makeExecutionLogger([]);
    const { provider, calls } = makeDataProvider([]);
    const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

    await query("purchase_request");

    expect(calls[0]?.filter).toEqual({});
  });

  test("honors a custom executionLogPageSize", async () => {
    const { logger, calls } = makeExecutionLogger([]);
    const { provider } = makeDataProvider([]);
    const query = createDispatchQuery({
      dataProvider: provider,
      executionLogger: logger,
      executionLogPageSize: 50,
    });

    await query("execution_log");

    expect(calls[0]?.options?.pageSize).toBe(50);
  });

  describe("tenant scoping (#500)", () => {
    test("passes tenantId as DataQueryOptions for business reads when scoped", async () => {
      const { logger } = makeExecutionLogger([]);
      const { provider, calls } = makeDataProvider([]);
      const query = createDispatchQuery({
        dataProvider: provider,
        executionLogger: logger,
        tenantId: "tenant-a",
      });

      await query("purchase_request", { status: "draft" });

      expect(calls).toHaveLength(1);
      // Filter is untouched; tenant scope rides DataQueryOptions (the canonical,
      // provider-enforced isolation mechanism), NOT the equality filter.
      expect(calls[0]?.filter).toEqual({ status: "draft" });
      expect(calls[0]?.options).toEqual({ tenantId: "tenant-a" });
    });

    test("forwards tenantId to ExecutionLogger.findMany when scoped", async () => {
      const { logger, calls } = makeExecutionLogger([]);
      const { provider } = makeDataProvider([]);
      const query = createDispatchQuery({
        dataProvider: provider,
        executionLogger: logger,
        tenantId: "tenant-a",
      });

      await query("execution_log", { action_name: "reject_purchase_request" });

      // The action engine stamps execOptions.tenantId onto each log entry, and
      // both loggers filter findMany by tenantId — so the read is tenant-scoped.
      expect(calls[0]?.options).toMatchObject({
        action: "reject_purchase_request",
        tenantId: "tenant-a",
      });
    });

    test("rejects a set-but-blank tenantId at construction (fail-closed, not silent global)", () => {
      const { logger } = makeExecutionLogger([]);
      const { provider } = makeDataProvider([]);
      // Real providers only scope on a TRUTHY tenantId, so "" / "  " would read
      // globally. Reject it loudly at construction rather than leak across tenants.
      expect(() =>
        createDispatchQuery({ dataProvider: provider, executionLogger: logger, tenantId: "" }),
      ).toThrow(/non-empty string or undefined/);
      expect(() =>
        createDispatchQuery({ dataProvider: provider, executionLogger: logger, tenantId: "  " }),
      ).toThrow(/non-empty string or undefined/);
    });

    test("unscoped (no tenantId) leaves both reads un-tenant-scoped", async () => {
      const { logger, calls: loggerCalls } = makeExecutionLogger([]);
      const { provider, calls: providerCalls } = makeDataProvider([]);
      const query = createDispatchQuery({ dataProvider: provider, executionLogger: logger });

      await query("purchase_request", { status: "draft" });
      await query("execution_log", { action_name: "x" });

      expect(providerCalls[0]?.options).toBeUndefined();
      expect(loggerCalls[0]?.options?.tenantId).toBeUndefined();
    });
  });
});
