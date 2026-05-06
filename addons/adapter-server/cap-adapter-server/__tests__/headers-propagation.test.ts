/**
 * Issue #236 — request headers propagate through CommandLayer for GraphQL,
 * matching the REST contract.
 *
 * A CommandLayer middleware reads `ctx.headers["x-linch-trace"]` and writes
 * it into the action's meta. The same trace value must be observable
 * regardless of whether the action was invoked over REST `/api/actions/:name`
 * or via the GraphQL `executeAction` / `batch_actions` / typed CRUD
 * mutations / `<entity>_onchange` mutations.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionContext, ActionDefinition, EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  createEntityRegistry,
  createOnchangeEvaluator,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const taskEntity: EntityDefinition = {
  name: "trace_task",
  label: "TraceTask",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    code: { type: "string", label: "Code" },
    description: { type: "string", label: "Description" },
  },
  onchange: {
    code: {
      updates: ["description"],
      compute: (ctx) => ({ description: `code=${ctx.value}` }),
    },
  },
};

interface CapturedExecution {
  action: string;
  /** trace header observed by the permission middleware via ctx.headers */
  observedTrace: string | undefined;
  /** all headers seen by the middleware (lowercase keyed) */
  allHeaders: Record<string, string> | undefined;
}

const captures: CapturedExecution[] = [];

/**
 * Standalone middleware-level trace captures — populated unconditionally
 * regardless of whether the action handler runs. Used by the onchange test
 * (skipActionSlots path) where no action handler executes.
 */
const middlewareTraces: Array<{ command: string; trace: string | undefined }> = [];

function recordCapture(name: string, ctx: ActionContext): void {
  const headers = ctx.meta.toJSON().captured_headers as Record<string, string> | undefined;
  captures.push({
    action: name,
    observedTrace: headers?.["x-linch-trace"],
    allHeaders: headers,
  });
}

// A no-op handler that captures meta — used by GraphQL executeAction tests.
const probeAction: ActionDefinition = {
  name: "probe_headers",
  entity: "trace_task",
  label: "Probe Headers",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    recordCapture("probe_headers", ctx);
    return { ok: true };
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

executor.registry.register(probeAction);
for (const action of generateCrudActions(taskEntity)) {
  // Wrap CRUD handlers so meta is captured under the CRUD action name.
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

// Permission slot middleware that copies request headers into meta so the
// action handler can observe what the pipeline saw. This is the exact
// "branches on headers" pattern issue #236 calls out.
commandLayer.use({
  name: "header_capture",
  slot: "permission",
  handler: async (ctx, next) => {
    // Record middleware-level visibility (independent of whether the action
    // handler subsequently runs — needed for skipActionSlots paths like
    // onchange).
    middlewareTraces.push({
      command: ctx.command,
      trace: ctx.headers?.["x-linch-trace"],
    });
    if (ctx.headers) {
      // Stash a snapshot under a non-system key. (`_`-prefixed keys are
      // re-stripped by the action engine at root depth; user-meta keys
      // survive intact.)
      ctx.meta.captured_headers = { ...ctx.headers };
    }
    await next();
  },
});

const entityRegistry = createEntityRegistry();
entityRegistry.register(taskEntity);
const onchangeEvaluator = createOnchangeEvaluator({ entityRegistry, dataProvider: store });

const graphqlSchema = buildGraphQLSchema([taskEntity], {
  executor,
  commandLayer,
  dataProvider: store,
  actions: [probeAction],
  onchangeEvaluator,
});

const app = createServer(graphqlSchema, {
  executor,
  commandLayer,
  entityRegistry,
  dataProvider: store,
  onchangeEvaluator,
});

const port = 4321;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

function clearCaptures(): void {
  captures.length = 0;
  middlewareTraces.length = 0;
}

async function postRest(
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

async function gql(
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
): Promise<{ data?: Record<string, unknown>; errors?: Array<Record<string, unknown>> }> {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<Record<string, unknown>>;
  };
}

// ── Tests ─────────────────────────────────────────────────

describe("Issue #236 — request headers propagate through CommandLayer (REST + GraphQL parity)", () => {
  test("REST single-action: middleware observes x-linch-trace header", async () => {
    clearCaptures();
    const { status } = await postRest(
      "probe_headers",
      {},
      { "X-Linch-Trace": "rest-single-trace-1" },
    );
    expect(status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0].observedTrace).toBe("rest-single-trace-1");
  });

  test("GraphQL executeAction: middleware observes x-linch-trace header (REST parity)", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Run($name: String!, $input: String!) {
          executeAction(name: $name, input: $input) {
            success
            executionId
          }
        }
      `,
      { name: "probe_headers", input: JSON.stringify({}) },
      { "X-Linch-Trace": "gql-execute-trace-1" },
    );
    expect(result.errors).toBeUndefined();
    expect(captures).toHaveLength(1);
    expect(captures[0].observedTrace).toBe("gql-execute-trace-1");
  });

  test("GraphQL typed mutation (createTraceTask): headers propagate", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Create($input: TraceTaskInput!) {
          createTraceTask(input: $input) {
            id
            title
          }
        }
      `,
      { input: { title: "from-gql" } },
      { "X-Linch-Trace": "gql-create-trace-1" },
    );
    expect(result.errors).toBeUndefined();
    const createCap = captures.find((c) => c.action === "create_trace_task");
    expect(createCap).toBeDefined();
    expect(createCap?.observedTrace).toBe("gql-create-trace-1");
  });

  test("GraphQL batch_actions: headers propagate to every batch item", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Batch($actions: [BatchActionInputItem!]!, $strategy: String) {
          batch_actions(actions: $actions, strategy: $strategy) {
            success
            summary { total succeeded failed }
          }
        }
      `,
      {
        actions: [
          { name: "probe_headers", input: JSON.stringify({}) },
          { name: "probe_headers", input: JSON.stringify({}) },
        ],
        strategy: "partial",
      },
      { "X-Linch-Trace": "gql-batch-trace-1" },
    );
    expect(result.errors).toBeUndefined();
    expect(captures.length).toBeGreaterThanOrEqual(2);
    expect(captures[0].observedTrace).toBe("gql-batch-trace-1");
    expect(captures[1].observedTrace).toBe("gql-batch-trace-1");
  });

  test("REST and GraphQL produce identical trace observations for the same header value", async () => {
    clearCaptures();
    await postRest("probe_headers", {}, { "X-Linch-Trace": "parity-trace" });
    const restTrace = captures[0].observedTrace;

    clearCaptures();
    await gql(
      `
        mutation Run($name: String!, $input: String!) {
          executeAction(name: $name, input: $input) { success }
        }
      `,
      { name: "probe_headers", input: JSON.stringify({}) },
      { "X-Linch-Trace": "parity-trace" },
    );
    const gqlTrace = captures[0].observedTrace;

    expect(restTrace).toBe("parity-trace");
    expect(gqlTrace).toBe("parity-trace");
    expect(restTrace).toBe(gqlTrace);
  });

  test("Headers are absent when not sent (transport doesn't fabricate values)", async () => {
    clearCaptures();
    await gql(
      `
        mutation Run($name: String!, $input: String!) {
          executeAction(name: $name, input: $input) { success }
        }
      `,
      { name: "probe_headers", input: JSON.stringify({}) },
    );
    expect(captures).toHaveLength(1);
    expect(captures[0].observedTrace).toBeUndefined();
  });

  test("GraphQL <entity>_onchange mutation: headers propagate to skipActionSlots dispatch", async () => {
    clearCaptures();
    const result = await gql(
      `
        mutation Onchange($field: String!, $values: String!) {
          trace_task_onchange(changedField: $field, values: $values) {
            updates
            warnings
          }
        }
      `,
      { field: "code", values: JSON.stringify({ code: "abc" }) },
      { "X-Linch-Trace": "gql-onchange-trace-1" },
    );
    expect(result.errors).toBeUndefined();
    // The onchange path uses `skipActionSlots: true`, so no action handler
    // runs — assert directly via the middleware-level trace capture which
    // fires regardless of whether the action runs.
    const onchangeMw = middlewareTraces.find((m) => m.command === "trace_task.onchange");
    expect(onchangeMw).toBeDefined();
    expect(onchangeMw?.trace).toBe("gql-onchange-trace-1");
  });
});
