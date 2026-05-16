/**
 * Smoke tests for cap-audit-ui.
 *
 * Bun's default test runner has no DOM, so these tests focus on the
 * exported surface and the pure helpers (filter serialization, list
 * mapping, detail JSON parsing) that drive the views. Render-level
 * tests are deferred until the repo gains a DOM testing harness.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Stub the cap-adapter-ui api module BEFORE the audit-api import below
// so `graphql()` is intercepted. mock.module must be set up before any
// dynamic imports of the consumer.
const graphqlMock = mock(async (_query: string, _vars?: Record<string, unknown>) => ({ data: {} }));

mock.module("@linchkit/cap-adapter-ui/lib/api", () => ({
  graphql: graphqlMock,
}));

const { AUDIT_STATUSES, buildAuditFilter, queryAuditDetail, queryAuditList } = await import(
  "../src/lib/audit-api"
);
const { capAuditUi } = await import("../src/capability");
const viewsModule = await import("../src/index");

beforeEach(() => {
  graphqlMock.mockClear();
});

afterEach(() => {
  graphqlMock.mockReset();
});

// ── Capability metadata ─────────────────────────────────

describe("capAuditUi", () => {
  it("declares the expected name, type, group, and dependencies", () => {
    expect(capAuditUi.name).toBe("cap-audit-ui");
    expect(capAuditUi.type).toBe("standard");
    expect(capAuditUi.category).toBe("system");
    expect(capAuditUi.group).toBe("audit");
    expect(capAuditUi.dependencies).toEqual(["cap-adapter-ui"]);
    expect(capAuditUi.autoInstall).toBe(true);
  });
});

// ── Public exports surface ──────────────────────────────

describe("cap-audit-ui exports", () => {
  it("exposes the views, capability, and api helpers", () => {
    expect(viewsModule.capAuditUi).toBe(capAuditUi);
    expect(typeof viewsModule.AuditList).toBe("function");
    expect(typeof viewsModule.AuditDetailView).toBe("function");
    expect(typeof viewsModule.AuditFiltersBar).toBe("function");
    expect(typeof viewsModule.queryAuditList).toBe("function");
    expect(typeof viewsModule.queryAuditDetail).toBe("function");
    expect(viewsModule.AUDIT_STATUSES).toEqual(AUDIT_STATUSES);
  });
});

// ── Filter serialization ────────────────────────────────

describe("buildAuditFilter", () => {
  it("returns undefined when no filter is set", () => {
    expect(buildAuditFilter({})).toBeUndefined();
  });

  it("maps filter keys to system schema column names", () => {
    const raw = buildAuditFilter({
      action: "create_order",
      actorId: "user-1",
      status: "succeeded",
      entity: "order",
    });
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed).toEqual({
      action_name: "create_order",
      actor_id: "user-1",
      status: "succeeded",
      entity_name: "order",
    });
  });

  it("drops startedAfter/startedBefore until SystemDataProvider supports range operators", () => {
    // SystemDataProvider currently uses equality-only filters; emitting a
    // { gte, lte } clause silently returns zero rows. The UI fields stay so
    // the layout is stable, but the wire payload must omit them for now.
    const raw = buildAuditFilter({
      action: "create_order",
      startedAfter: "2026-01-01T00:00:00.000Z",
      startedBefore: "2026-01-02T00:00:00.000Z",
    });
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed).toEqual({ action_name: "create_order" });
    expect(parsed.started_at).toBeUndefined();
  });

  it("drops empty string values", () => {
    const raw = buildAuditFilter({ action: "", actorId: "user-1" });
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed).toEqual({ actor_id: "user-1" });
    expect(parsed.action_name).toBeUndefined();
  });
});

// ── queryAuditList wiring ───────────────────────────────

describe("queryAuditList", () => {
  it("sends the configured filter, page, and sort to executionLogList", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        executionLogList: {
          items: [
            {
              id: "exec-1",
              action_name: "create_order",
              entity_name: "order",
              record_id: "ord-9",
              actor_id: "user-1",
              actor_type: "user",
              status: "succeeded",
              duration_ms: 42,
              error_code: null,
              error_message: null,
              started_at: "2026-05-16T12:00:00.000Z",
              completed_at: "2026-05-16T12:00:00.042Z",
            },
          ],
          total: 1,
        },
      },
    }));

    const result = await queryAuditList({
      filters: { action: "create_order" },
      page: 2,
      pageSize: 25,
    });

    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const [, vars] = graphqlMock.mock.calls[0] ?? [];
    expect(vars).toMatchObject({
      filter: JSON.stringify({ action_name: "create_order" }),
      page: 2,
      pageSize: 25,
      sortField: "started_at",
      sortOrder: "desc",
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "exec-1",
      action: "create_order",
      entity: "order",
      recordId: "ord-9",
      actorId: "user-1",
      actorType: "user",
      status: "succeeded",
      durationMs: 42,
    });
  });

  it("throws when the GraphQL response carries errors", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      errors: [{ message: "boom" }],
    }));

    await expect(queryAuditList()).rejects.toThrow("boom");
  });

  it("returns an empty result when the server returns no data", async () => {
    graphqlMock.mockImplementationOnce(async () => ({ data: {} }));

    const result = await queryAuditList();
    expect(result).toEqual({ items: [], total: 0 });
  });
});

// ── queryAuditDetail wiring ─────────────────────────────

describe("queryAuditDetail", () => {
  it("parses JSON-string input/output/meta payloads", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        executionLogList: {
          items: [
            {
              id: "exec-1",
              action_name: "create_order",
              entity_name: "order",
              record_id: "ord-9",
              capability: "cap-purchase",
              channel: "graphql",
              actor_id: "user-1",
              actor_type: "user",
              status: "succeeded",
              duration_ms: 42,
              error_code: null,
              error_message: null,
              input: JSON.stringify({ amount: 100 }),
              output: JSON.stringify({ ok: true }),
              meta: JSON.stringify({
                _channel: "graphql",
                stateTransition: { from: "draft", to: "submitted" },
              }),
              started_at: "2026-05-16T12:00:00.000Z",
              completed_at: "2026-05-16T12:00:00.042Z",
            },
          ],
        },
      },
    }));

    const detail = await queryAuditDetail("exec-1");
    expect(detail).not.toBeNull();
    expect(detail?.input).toEqual({ amount: 100 });
    expect(detail?.output).toEqual({ ok: true });
    expect(detail?.meta).toMatchObject({
      _channel: "graphql",
      stateTransition: { from: "draft", to: "submitted" },
    });
    expect(detail?.stateTransitionFrom).toBe("draft");
    expect(detail?.stateTransitionTo).toBe("submitted");
    expect(detail?.capability).toBe("cap-purchase");
  });

  it("returns null when no row matches the id", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: { executionLogList: { items: [] } },
    }));

    expect(await queryAuditDetail("missing")).toBeNull();
  });
});
