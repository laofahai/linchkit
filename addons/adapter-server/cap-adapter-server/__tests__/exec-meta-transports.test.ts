/**
 * Spec 65 Phase 2A — REST `X-Linch-Meta` header + GraphQL `meta` argument
 * end-to-end transport tests.
 *
 * Verifies that:
 *  - REST single-action handler parses the header and threads meta to the
 *    action handler's `ctx.meta`.
 *  - REST batch handler parses the header once and applies it to every item.
 *  - GraphQL `executeAction` and CRUD mutations accept the `meta` arg, parse
 *    it via the same `safeParseJSON` helper used for `input`, and surface
 *    errors as GraphQL errors.
 *  - System-key spoofing through either transport is silently re-stamped by
 *    the action engine (Phase 1 contract).
 *  - Malformed headers / args produce structured error responses, not 500s.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionContext, ActionDefinition, EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

/** Captures every handler invocation's meta snapshot and execution id. */
interface CapturedExecution {
  action: string;
  meta: Record<string, unknown>;
  executionId: string;
}
const captures: CapturedExecution[] = [];

function recordCapture(name: string, ctx: ActionContext): void {
  captures.push({
    action: name,
    meta: ctx.meta.toJSON(),
    executionId: ctx.executionId,
  });
}

const captureMetaAction: ActionDefinition = {
  name: "capture_meta",
  entity: "task",
  label: "Capture Meta",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    recordCapture("capture_meta", ctx);
    return { ok: true };
  },
};

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const executor = createActionExecutor({
  dataProvider: store,
  executionLogger,
});

// Register a small set of actions: capture_meta + auto-generated CRUD.
executor.registry.register(captureMetaAction);
for (const action of generateCrudActions(taskSchema)) {
  // Wrap CRUD handlers so the meta is also captured under the CRUD action name.
  // This avoids redefining CRUD logic — we only need to observe meta flow.
  const original = action.handler;
  const wrapped: ActionDefinition = {
    ...action,
    handler: async (ctx) => {
      recordCapture(action.name, ctx);
      if (!original) return undefined;
      return original(ctx);
    },
  };
  executor.registry.register(wrapped);
}

const commandLayer = createCommandLayer({ executor });

const graphqlSchema = buildGraphQLSchema([taskSchema], {
  executor,
  commandLayer,
  dataProvider: store,
  actions: [captureMetaAction],
});
const app = createServer(graphqlSchema, { executor, commandLayer });
const port = 4099;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

function clearCaptures(): void {
  captures.length = 0;
}

async function postAction(
  name: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function postBatch(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/api/actions/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function gql(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: Array<Record<string, unknown>> }> {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{
    data?: Record<string, unknown>;
    errors?: Array<Record<string, unknown>>;
  }>;
}

// ── Tests: REST X-Linch-Meta single-action ────────────────

describe("REST single-action — X-Linch-Meta header (Spec 65 §3.1)", () => {
  test("valid JSON object header surfaces in handler ctx.meta", async () => {
    clearCaptures();
    const { status, body } = await postAction(
      "capture_meta",
      {},
      { "X-Linch-Meta": JSON.stringify({ source_view: "queue", bulk: true }) },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0].meta.source_view).toBe("queue");
    expect(captures[0].meta.bulk).toBe(true);
    expect(captures[0].meta._channel).toBe("http");
  });

  test("missing header → ctx.meta has no caller keys (system keys still set)", async () => {
    clearCaptures();
    const { status } = await postAction("capture_meta", {});
    expect(status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0].meta.source_view).toBeUndefined();
    expect(captures[0].meta.bulk).toBeUndefined();
    // Phase 1 system keys still flow through.
    expect(captures[0].meta._channel).toBe("http");
    expect(typeof captures[0].meta._execution_id).toBe("string");
  });

  test("_-prefixed keys in header are stripped (system keys win)", async () => {
    clearCaptures();
    await postAction(
      "capture_meta",
      {},
      {
        "X-Linch-Meta": JSON.stringify({
          _channel: "spoofed",
          _execution_id: "fake_id",
          legit: "yes",
        }),
      },
    );
    const meta = captures[0]?.meta ?? {};
    expect(meta._channel).toBe("http");
    expect(meta._execution_id).not.toBe("fake_id");
    expect(meta.legit).toBe("yes");
  });

  test("non-JSON header → 400 META.PARSE.INVALID_JSON", async () => {
    const { status, body } = await postAction(
      "capture_meta",
      {},
      { "X-Linch-Meta": "this-is-not-json" },
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("META.PARSE.INVALID_JSON");
  });

  test("array (non-object) header → 400 META.PARSE.NOT_OBJECT", async () => {
    const { status, body } = await postAction(
      "capture_meta",
      {},
      { "X-Linch-Meta": JSON.stringify([1, 2, 3]) },
    );
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("META.PARSE.NOT_OBJECT");
  });

  test("oversized header (>8 KB) → 400 META.PARSE.OVERSIZE", async () => {
    const huge = JSON.stringify({ blob: "x".repeat(9000) });
    const { status, body } = await postAction("capture_meta", {}, { "X-Linch-Meta": huge });
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("META.PARSE.OVERSIZE");
  });
});

// ── Tests: REST batch ─────────────────────────────────────

describe("REST batch — X-Linch-Meta header (Spec 65 §3.1)", () => {
  test("header applies to every batch item via ctx.meta", async () => {
    clearCaptures();
    const { status, body } = await postBatch(
      {
        actions: [
          { name: "capture_meta", input: {} },
          { name: "capture_meta", input: {} },
        ],
        strategy: "partial",
      },
      { "X-Linch-Meta": JSON.stringify({ run_id: "batch-1" }) },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(captures).toHaveLength(2);
    expect(captures[0].meta.run_id).toBe("batch-1");
    expect(captures[1].meta.run_id).toBe("batch-1");
    // Phase 1 batch keys also stamped on each item.
    expect(captures[0].meta["batch.index"]).toBe(0);
    expect(captures[1].meta["batch.index"]).toBe(1);
  });

  test("malformed batch header → 400 even before batch validation runs", async () => {
    const { status, body } = await postBatch(
      { actions: [{ name: "capture_meta", input: {} }], strategy: "partial" },
      { "X-Linch-Meta": "{not-json" },
    );
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("META.PARSE.INVALID_JSON");
  });
});

// ── Tests: GraphQL meta argument ──────────────────────────

describe("GraphQL — meta argument (Spec 65 §3.2)", () => {
  test("executeAction with meta arg surfaces in handler ctx.meta", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Run($name: String!, $input: String!, $meta: String) {
          executeAction(name: $name, input: $input, meta: $meta) {
            success
            executionId
          }
        }
      `,
      {
        name: "capture_meta",
        input: JSON.stringify({}),
        meta: JSON.stringify({ source_view: "graphql_explorer", bulk: false }),
      },
    );

    expect(result.errors).toBeUndefined();
    expect(captures).toHaveLength(1);
    expect(captures[0].meta.source_view).toBe("graphql_explorer");
    expect(captures[0].meta.bulk).toBe(false);
  });

  test("createTask mutation with meta arg threads through to action handler", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Create($input: TaskInput!, $meta: String) {
          createTask(input: $input, meta: $meta) {
            id
            title
          }
        }
      `,
      {
        input: { title: "From GraphQL with meta" },
        meta: JSON.stringify({ source_view: "task_form" }),
      },
    );

    expect(result.errors).toBeUndefined();
    const created = (captures.find((c) => c.action === "create_task")?.meta ?? {}) as Record<
      string,
      unknown
    >;
    expect(created.source_view).toBe("task_form");
    expect(created._channel).toBe("http");
  });

  test("updateTask mutation with meta arg threads through", async () => {
    clearCaptures();
    await store.create("task", { id: "gql_meta_update", title: "Initial" });

    const result = await gql(
      `
        mutation Upd($id: ID!, $input: TaskInput!, $meta: String) {
          updateTask(id: $id, input: $input, meta: $meta) {
            id
            title
          }
        }
      `,
      {
        id: "gql_meta_update",
        input: { title: "Updated" },
        meta: JSON.stringify({ triggered_by: "test" }),
      },
    );

    expect(result.errors).toBeUndefined();
    const updateCap = captures.find((c) => c.action === "update_task");
    expect(updateCap).toBeDefined();
    expect(updateCap?.meta.triggered_by).toBe("test");
  });

  test("invalid JSON in meta arg → GraphQL error", async () => {
    const result = await gql(
      `
        mutation Run($name: String!, $input: String!, $meta: String) {
          executeAction(name: $name, input: $input, meta: $meta) {
            success
          }
        }
      `,
      {
        name: "capture_meta",
        input: JSON.stringify({}),
        meta: "not valid json",
      },
    );

    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("invalid JSON");
  });

  test("non-object meta arg → GraphQL error", async () => {
    const result = await gql(
      `
        mutation Run($name: String!, $input: String!, $meta: String) {
          executeAction(name: $name, input: $input, meta: $meta) {
            success
          }
        }
      `,
      {
        name: "capture_meta",
        input: JSON.stringify({}),
        meta: JSON.stringify([1, 2, 3]),
      },
    );

    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("must be a JSON object");
  });

  test("_-prefixed keys in meta arg are stripped (system keys win)", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Run($name: String!, $input: String!, $meta: String) {
          executeAction(name: $name, input: $input, meta: $meta) {
            success
          }
        }
      `,
      {
        name: "capture_meta",
        input: JSON.stringify({}),
        meta: JSON.stringify({
          _channel: "evil",
          _execution_id: "spoofed",
          allowed: 1,
        }),
      },
    );

    expect(result.errors).toBeUndefined();
    const meta = captures[0]?.meta ?? {};
    expect(meta._channel).toBe("http");
    expect(meta._execution_id).not.toBe("spoofed");
    expect(meta.allowed).toBe(1);
  });
});
