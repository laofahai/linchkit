/**
 * GraphQL events surface — exercises the three operations registered by
 * `buildEventsGraphQLExtension` end-to-end through a real GraphQL schema:
 *
 *   - `eventList`
 *   - `eventHandlerHistory`
 *   - `eventReplay`
 *
 * The tests stub `EventReplayService` so the surface can be validated
 * without a running PostgreSQL — the resolvers' contract with the service
 * is documented by these expectations.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  EventDetail,
  EventListOptions,
  EventReplayService,
  HandlerExecution,
  HandlerHistoryQuery,
  ReplayOptions,
  ReplayResult,
} from "@linchkit/core";
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from "graphql";
import { buildEventsGraphQLExtension } from "../src/graphql/events";

// ── Stub service helpers ────────────────────────────────────

interface StubServiceOptions {
  listImpl?: EventReplayService["list"];
  getImpl?: EventReplayService["get"];
  replayImpl?: EventReplayService["replay"];
  handlerHistoryImpl?: EventReplayService["handlerHistory"];
}

function createStubService(opts: StubServiceOptions = {}): EventReplayService {
  return {
    list: opts.listImpl ?? (async (_o?: EventListOptions) => ({ items: [], total: 0 })),
    get: opts.getImpl ?? (async (_id: string): Promise<EventDetail | null> => null),
    replay:
      opts.replayImpl ??
      (async (_id: string, _o?: ReplayOptions): Promise<ReplayResult> => ({
        delivered: 0,
        errors: [],
      })),
    replayBatch: async () => ({ results: [], totalDelivered: 0, totalErrors: 0 }),
    handlerHistory:
      opts.handlerHistoryImpl ??
      (async (_q: HandlerHistoryQuery): Promise<HandlerExecution[]> => []),
  };
}

function buildSchema(service: EventReplayService): GraphQLSchema {
  const ext = buildEventsGraphQLExtension({ service });
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        ping: { type: new GraphQLNonNull(GraphQLString), resolve: () => "pong" },
        ...ext.queryFields,
      },
    }),
    mutation: new GraphQLObjectType({
      name: "Mutation",
      fields: { ...ext.mutationFields },
    }),
  });
}

// Admin actor used by every test except the explicit forbidden case.
const ADMIN_CTX = {
  actor: { id: "u-admin", type: "human", groups: ["admin"] },
  tenantId: "t1",
};

// ── eventList ──────────────────────────────────────────────

describe("graphql events / eventList", () => {
  test("projects EventSummary rows to the wire shape and respects pagination", async () => {
    const listImpl = mock(async (_opts?: EventListOptions) => ({
      items: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          tenantId: "t1",
          eventType: "order.created",
          status: "completed" as const,
          sourceAction: "create_order",
          sourceExecutionId: "exec-1",
          retryCount: 0,
          errorMessage: undefined,
          createdAt: new Date("2026-05-16T08:30:00Z"),
          processedAt: new Date("2026-05-16T08:30:01Z"),
        },
      ],
      total: 42,
    }));
    const schema = buildSchema(createStubService({ listImpl }));
    const result = await graphql({
      schema,
      source: `
        query {
          eventList(limit: 5, offset: 10) {
            total
            events {
              id tenantId eventType status
              sourceAction sourceExecutionId
              retryCount errorMessage
              createdAt processedAt
            }
          }
        }
      `,
      contextValue: ADMIN_CTX,
    });

    expect(result.errors).toBeUndefined();
    const data = result.data?.eventList as {
      total: number;
      events: Array<{
        id: string;
        tenantId: string | null;
        eventType: string;
        status: string;
        sourceAction: string | null;
        sourceExecutionId: string | null;
        retryCount: number;
        errorMessage: string | null;
        createdAt: string;
        processedAt: string | null;
      }>;
    };

    expect(data.total).toBe(42);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      tenantId: "t1",
      eventType: "order.created",
      status: "completed",
      sourceAction: "create_order",
      sourceExecutionId: "exec-1",
      retryCount: 0,
      errorMessage: null,
      createdAt: "2026-05-16T08:30:00.000Z",
      processedAt: "2026-05-16T08:30:01.000Z",
    });

    expect(listImpl).toHaveBeenCalledTimes(1);
    const passed = listImpl.mock.calls[0]?.[0];
    expect(passed?.limit).toBe(5);
    expect(passed?.offset).toBe(10);
    expect(passed?.tenantId).toBe("t1");
  });

  test("forwards tenant scope from context", async () => {
    const listImpl = mock(async (_opts?: EventListOptions) => ({
      items: [],
      total: 0,
    }));
    const schema = buildSchema(createStubService({ listImpl }));
    await graphql({
      schema,
      source: `{ eventList { total } }`,
      contextValue: {
        actor: { id: "u-admin", type: "human", groups: ["admin"] },
        tenantId: "tenant-A",
      },
    });
    expect(listImpl.mock.calls[0]?.[0]?.tenantId).toBe("tenant-A");
  });

  test("rejects unauthenticated callers", async () => {
    const schema = buildSchema(createStubService());
    const result = await graphql({
      schema,
      source: `{ eventList { total } }`,
      contextValue: {
        actor: { id: "anonymous", type: "system", groups: [] },
        tenantId: "t1",
      },
    });
    expect(result.errors?.[0]?.message).toMatch(/forbidden/i);
  });

  test("rejects authenticated callers without admin group", async () => {
    const schema = buildSchema(createStubService());
    const result = await graphql({
      schema,
      source: `{ eventList { total } }`,
      contextValue: {
        actor: { id: "u-1", type: "human", groups: ["sales"] },
        tenantId: "t1",
      },
    });
    expect(result.errors?.[0]?.message).toMatch(/forbidden/i);
  });

  test("rejects malformed ISO dates", async () => {
    const schema = buildSchema(createStubService());
    const result = await graphql({
      schema,
      source: `query($s: String) { eventList(since: $s) { total } }`,
      variableValues: { s: "not-a-date" },
      contextValue: ADMIN_CTX,
    });
    expect(result.errors?.[0]?.message).toMatch(/invalid iso/i);
  });
});

// ── eventHandlerHistory ─────────────────────────────────────

describe("graphql events / eventHandlerHistory", () => {
  test("projects HandlerExecution into the wire shape with derived durationMs", async () => {
    const getImpl = mock(
      async (id: string): Promise<EventDetail | null> => ({
        id,
        tenantId: "t1",
        eventType: "order.created",
        status: "completed",
        sourceAction: "create_order",
        sourceExecutionId: "exec-1",
        retryCount: 0,
        errorMessage: undefined,
        createdAt: new Date("2026-05-16T08:30:00Z"),
        processedAt: new Date("2026-05-16T08:30:01Z"),
        payload: {},
        meta: null,
        history: [],
      }),
    );
    const handlerHistoryImpl = mock(
      async (_q: HandlerHistoryQuery): Promise<HandlerExecution[]> => [
        {
          eventId: "id-1",
          handler: "*",
          status: "completed",
          retryCount: 0,
          errorMessage: undefined,
          attemptedAt: new Date("2026-05-16T08:30:00Z"),
          completedAt: new Date("2026-05-16T08:30:00.250Z"),
        },
      ],
    );
    const schema = buildSchema(createStubService({ getImpl, handlerHistoryImpl }));

    const result = await graphql({
      schema,
      source: `query($id: ID!) {
        eventHandlerHistory(eventId: $id) {
          handler status durationMs error
        }
      }`,
      variableValues: { id: "id-1" },
      contextValue: ADMIN_CTX,
    });

    expect(result.errors).toBeUndefined();
    const rows = result.data?.eventHandlerHistory as Array<{
      handler: string;
      status: string;
      durationMs: number | null;
      error: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      handler: "*",
      status: "completed",
      durationMs: 250,
      error: null,
    });
  });

  test("returns an empty list when the event is missing", async () => {
    const schema = buildSchema(createStubService());
    const result = await graphql({
      schema,
      source: `{ eventHandlerHistory(eventId: "missing") { handler } }`,
      contextValue: ADMIN_CTX,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.eventHandlerHistory).toEqual([]);
  });

  test("rejects cross-tenant access", async () => {
    const getImpl = async (id: string): Promise<EventDetail | null> => ({
      id,
      tenantId: "OTHER",
      eventType: "x",
      status: "completed",
      retryCount: 0,
      createdAt: new Date(),
      payload: {},
      meta: null,
      history: [],
    });
    const schema = buildSchema(createStubService({ getImpl }));
    const result = await graphql({
      schema,
      source: `{ eventHandlerHistory(eventId: "id-1") { handler } }`,
      contextValue: ADMIN_CTX,
    });
    expect(result.errors?.[0]?.message).toMatch(/different tenant/i);
  });
});

// ── eventReplay ─────────────────────────────────────────────

describe("graphql events / eventReplay", () => {
  function detailFor(id: string, tenantId: string | undefined = "t1"): EventDetail {
    return {
      id,
      tenantId,
      eventType: "order.created",
      status: "completed",
      sourceAction: "create_order",
      retryCount: 0,
      errorMessage: undefined,
      createdAt: new Date("2026-05-16T08:30:00Z"),
      payload: {},
      meta: null,
      history: [],
    };
  }

  test("dryRun does NOT invoke replay() and returns a zero-delivery report", async () => {
    const getImpl = mock(async (id: string) => detailFor(id));
    const replayImpl = mock(async (_id: string, _opts?: ReplayOptions) => ({
      delivered: 0,
      errors: [],
    }));
    const schema = buildSchema(createStubService({ getImpl, replayImpl }));

    const result = await graphql({
      schema,
      source: `mutation($id: ID!) {
        eventReplay(eventId: $id, dryRun: true) {
          eventId dryRun delivered failed
          handlers { handler status error }
        }
      }`,
      variableValues: { id: "id-1" },
      contextValue: ADMIN_CTX,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.eventReplay).toEqual({
      eventId: "id-1",
      dryRun: true,
      delivered: 0,
      failed: 0,
      handlers: [],
    });
    expect(replayImpl).toHaveBeenCalledTimes(0);
    expect(getImpl).toHaveBeenCalledTimes(1);
  });

  test("live replay invokes replay() and surfaces handler errors in the handlers array", async () => {
    const getImpl = async (id: string) => detailFor(id);
    const replayImpl = mock(async (_id: string, opts?: ReplayOptions) => {
      expect(opts?.onlyHandler).toBe("email-handler");
      return {
        delivered: 1,
        errors: [{ handler: "billing-handler", message: "smtp down" }],
      };
    });
    const schema = buildSchema(createStubService({ getImpl, replayImpl }));

    const result = await graphql({
      schema,
      source: `mutation($id: ID!, $h: String) {
        eventReplay(eventId: $id, dryRun: false, handlers: $h) {
          eventId dryRun delivered failed
          handlers { handler status error }
        }
      }`,
      variableValues: { id: "id-1", h: "email-handler" },
      contextValue: ADMIN_CTX,
    });

    expect(result.errors).toBeUndefined();
    const report = result.data?.eventReplay as {
      eventId: string;
      dryRun: boolean;
      delivered: number;
      failed: number;
      handlers: Array<{ handler: string; status: string; error: string | null }>;
    };
    expect(report.eventId).toBe("id-1");
    expect(report.dryRun).toBe(false);
    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.handlers).toHaveLength(2);
    const errorEntry = report.handlers.find((h) => h.status === "error");
    expect(errorEntry?.handler).toBe("billing-handler");
    expect(errorEntry?.error).toBe("smtp down");
    const successEntry = report.handlers.find((h) => h.status === "success");
    expect(successEntry).toBeTruthy();
    expect(replayImpl).toHaveBeenCalledTimes(1);
  });

  test("returns a NOT_FOUND GraphQL error when the event is missing", async () => {
    const schema = buildSchema(createStubService());
    const result = await graphql({
      schema,
      source: `mutation {
        eventReplay(eventId: "missing") { eventId dryRun delivered failed handlers { handler status } }
      }`,
      contextValue: ADMIN_CTX,
    });
    expect(result.errors?.[0]?.message).toMatch(/not found/i);
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("rejects cross-tenant replay", async () => {
    const getImpl = async (id: string) => detailFor(id, "OTHER");
    const replayImpl = mock(async () => ({ delivered: 0, errors: [] }));
    const schema = buildSchema(createStubService({ getImpl, replayImpl }));
    const result = await graphql({
      schema,
      source: `mutation { eventReplay(eventId: "id-1") { eventId dryRun delivered failed handlers { handler status } } }`,
      contextValue: ADMIN_CTX,
    });
    expect(result.errors?.[0]?.message).toMatch(/different tenant/i);
    expect(replayImpl).toHaveBeenCalledTimes(0);
  });
});

// ── Wiring through buildGraphQLSchema ───────────────────────

describe("buildGraphQLSchema / eventReplayService wiring", () => {
  test("registers the three operations when eventReplayService is provided", async () => {
    const { buildGraphQLSchema } = await import("../src/graphql/build-schema");
    const svc = createStubService();
    const schema = buildGraphQLSchema([], { eventReplayService: svc });
    const typeMap = schema.getTypeMap();
    expect(schema.getQueryType()?.getFields().eventList).toBeDefined();
    expect(schema.getQueryType()?.getFields().eventHandlerHistory).toBeDefined();
    expect(schema.getMutationType()?.getFields().eventReplay).toBeDefined();
    expect(typeMap.EventSummary).toBeDefined();
    expect(typeMap.ReplayReport).toBeDefined();
  });

  test("omits the events surface entirely when eventReplayService is absent", async () => {
    const { buildGraphQLSchema } = await import("../src/graphql/build-schema");
    const schema = buildGraphQLSchema([]);
    expect(schema.getQueryType()?.getFields().eventList).toBeUndefined();
    expect(schema.getMutationType()).toBeUndefined();
  });
});
