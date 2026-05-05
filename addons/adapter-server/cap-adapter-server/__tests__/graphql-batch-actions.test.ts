/**
 * GraphQL `batch_actions` mutation integration tests (Spec 04 §8, issue #212).
 *
 * Mirrors the REST `POST /api/actions/batch` contract: per-item shape is
 * `{ name, input }`, response is the structured `BatchActionsResult` envelope
 * with succeeded / failed / rolledBack / summary. Verifies:
 *   - happy-path partial batch with two items, results returned in order
 *   - per-item failure surfaces with structured error code/message
 *   - all_or_nothing rollback populates `rolledBack` and reverts state
 *   - permission middleware on the CommandLayer protects every batch item
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  DataProvider,
  EntityDefinition,
  PendingEvent,
  TransactionManager,
} from "@linchkit/core";
import { createActionExecutor, createCommandLayer, PipelineError } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const itemSchema: EntityDefinition = {
  name: "item",
  label: "Item",
  fields: {
    title: { type: "string", required: true, label: "Title" },
  },
};

const createItem: ActionDefinition = {
  name: "create_item",
  entity: "item",
  label: "Create Item",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => ctx.create("item", { title: ctx.input.title }),
};

const failItem: ActionDefinition = {
  name: "fail_item",
  entity: "item",
  label: "Fail Item",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async () => {
    throw new Error("intentional failure");
  },
};

const adminOnly: ActionDefinition = {
  name: "delete_item",
  entity: "item",
  label: "Delete Item",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async () => ({ ok: true }),
};

// Snapshot-aware in-memory provider so we can verify rollback under
// `all_or_nothing`. Mirrors the REST batch test fixture.
function createSnapshotProvider() {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const provider: DataProvider = {
    async get(_schema, id) {
      const found = records.get(id);
      if (!found) throw new Error(`not found: ${id}`);
      return found;
    },
    async query() {
      return [];
    },
    async create(_schema, data) {
      counter++;
      const id = `rec_${counter}`;
      const rec = { id, ...data };
      records.set(id, rec);
      return rec;
    },
    async update(_schema, id, data) {
      const existing = records.get(id) ?? { id };
      const updated = { ...existing, ...data };
      records.set(id, updated);
      return updated;
    },
    async delete(_schema, id) {
      records.delete(id);
    },
    async count() {
      return records.size;
    },
  };
  return Object.assign(provider, {
    records,
    snapshot: () => new Map(records),
  });
}

function createFakeTxManager(
  provider: ReturnType<typeof createSnapshotProvider>,
): TransactionManager {
  return {
    async runInTransaction<T>(
      fn: (tx: DataProvider) => Promise<T>,
      _pending: PendingEvent[],
    ): Promise<T> {
      const before = provider.snapshot();
      try {
        return await fn(provider);
      } catch (err) {
        provider.records.clear();
        for (const [k, v] of before) provider.records.set(k, v);
        throw err;
      }
    },
  };
}

// ── Server setup ──────────────────────────────────────────

const provider = createSnapshotProvider();
const txManager = createFakeTxManager(provider);

const executor = createActionExecutor({
  dataProvider: provider,
  transactionManager: txManager,
});
executor.registry.register(createItem);
executor.registry.register(failItem);
executor.registry.register(adminOnly);

const commandLayer = createCommandLayer({ executor, transactionManager: txManager });
commandLayer.use({
  name: "test_permission",
  slot: "permission",
  handler: async (ctx, next) => {
    if (ctx.command === "delete_item" && !ctx.actor.groups.includes("admin")) {
      throw new PipelineError(
        "Actor does not belong to required group: admin",
        "PERMISSION.DENIED",
      );
    }
    await next();
  },
});

const graphqlSchema = buildGraphQLSchema([itemSchema], {
  executor,
  commandLayer,
  dataProvider: provider,
  actions: [createItem, failItem, adminOnly],
  transactionManager: txManager,
});

// Resolve a non-elevated anonymous actor so the permission middleware can
// actually deny `delete_item` in test (g). The default `NO_AUTH_ACTOR` used
// when no resolver is configured carries the `admin` group, which would
// trivially pass the `delete_item` check and defeat the test.
const app = createServer(graphqlSchema, {
  executor,
  commandLayer,
  transactionManager: txManager,
  resolveRequestActor: () => ({ type: "system", id: "anonymous", groups: [] }),
});

// Use OS-assigned port (0 → auto) so the suite isn't flaky when a parallel
// worker already owns a fixed port. Captured after `listen()` returns.
let port = 0;

beforeAll(() => {
  app.listen(0);
  const server = (app as unknown as { server?: { port?: number } }).server;
  if (!server?.port) throw new Error("Test server failed to bind to a port");
  port = server.port;
});

afterAll(() => {
  app.stop();
});

// ── Helpers ───────────────────────────────────────────────

interface BatchSucceededItem {
  index: number;
  executionId: string;
  data: string | null;
  record: string | null;
  warnings: string[] | null;
}

interface BatchFailedItem {
  index: number;
  executionId: string | null;
  error: { code: string; message: string; field: string | null };
}

interface BatchActionsResultGQL {
  success: boolean;
  parentExecutionId: string;
  strategy: string;
  succeeded: BatchSucceededItem[];
  failed: BatchFailedItem[];
  rolledBack: BatchSucceededItem[] | null;
  summary: { total: number; succeeded: number; failed: number };
}

const BATCH_SELECTION = `
  success
  parentExecutionId
  strategy
  succeeded { index executionId data record warnings }
  failed { index executionId error { code message field } }
  rolledBack { index executionId data record warnings }
  summary { total succeeded failed }
`;

async function gql(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{
  data?: { batch_actions?: BatchActionsResultGQL } & Record<string, unknown>;
  errors?: Array<{ message: string }>;
}> {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{
    data?: { batch_actions?: BatchActionsResultGQL } & Record<string, unknown>;
    errors?: Array<{ message: string }>;
  }>;
}

// ── Tests ────────────────────────────────────────────────

describe("GraphQL batch_actions mutation", () => {
  test("(a) partial batch runs both items and returns ordered results", async () => {
    provider.records.clear();
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "partial") {
          ${BATCH_SELECTION}
        }
      }`,
      {
        actions: [
          { name: "create_item", input: JSON.stringify({ title: "first" }) },
          { name: "create_item", input: JSON.stringify({ title: "second" }) },
        ],
      },
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.success).toBe(true);
    expect(batch.strategy).toBe("partial");
    expect(batch.succeeded.length).toBe(2);
    expect(batch.failed.length).toBe(0);
    expect(batch.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    // Results come back in the same order they were submitted.
    expect(batch.succeeded[0]?.index).toBe(0);
    expect(batch.succeeded[1]?.index).toBe(1);
    // The action handler returns the created record via `ctx.create`, which
    // surfaces as `data` on the per-item result. `record` is populated by the
    // executor for write actions that resolve a persisted entity — both paths
    // are JSON-encoded here, so we read whichever is set.
    const decode = (item: BatchSucceededItem | undefined) => {
      const raw = item?.data ?? item?.record;
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    };
    expect(decode(batch.succeeded[0])?.title).toBe("first");
    expect(decode(batch.succeeded[1])?.title).toBe("second");
  });

  test("(b) per-item failure surfaces with structured error", async () => {
    provider.records.clear();
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "partial") {
          ${BATCH_SELECTION}
        }
      }`,
      {
        actions: [
          { name: "create_item", input: JSON.stringify({ title: "ok" }) },
          { name: "fail_item", input: JSON.stringify({}) },
        ],
      },
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.success).toBe(false);
    expect(batch.strategy).toBe("partial");
    expect(batch.succeeded.length).toBe(1);
    expect(batch.succeeded[0]?.index).toBe(0);
    expect(batch.failed.length).toBe(1);
    expect(batch.failed[0]?.index).toBe(1);
    expect(typeof batch.failed[0]?.error.code).toBe("string");
    expect(batch.failed[0]?.error.message.length).toBeGreaterThan(0);
    expect(batch.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });

  test("(c) all_or_nothing rollback populates rolledBack and reverts state", async () => {
    provider.records.clear();
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "all_or_nothing") {
          ${BATCH_SELECTION}
        }
      }`,
      {
        actions: [
          { name: "create_item", input: JSON.stringify({ title: "A" }) },
          { name: "fail_item", input: JSON.stringify({}) },
        ],
      },
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.success).toBe(false);
    expect(batch.strategy).toBe("all_or_nothing");
    expect(batch.succeeded.length).toBe(0);
    expect(batch.failed.length).toBe(1);
    expect(batch.rolledBack).not.toBeNull();
    expect(batch.rolledBack?.length).toBe(1);
    expect(batch.rolledBack?.[0]?.index).toBe(0);
    expect(provider.records.size).toBe(0);
  });

  test("(d) empty actions array returns BATCH_EMPTY structured failure", async () => {
    const result = await gql(
      `mutation { batch_actions(actions: [], strategy: "partial") { ${BATCH_SELECTION} } }`,
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.success).toBe(false);
    expect(batch.failed[0]?.error.code).toBe("BATCH_EMPTY");
  });

  test("(e) unknown strategy is rejected at the GraphQL boundary", async () => {
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "fast") {
          success
        }
      }`,
      { actions: [{ name: "create_item", input: JSON.stringify({ title: "x" }) }] },
    );
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("must be 'all_or_nothing' or 'partial'");
  });

  test("(f) malformed JSON in item input is rejected before dispatch", async () => {
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "partial") {
          success
        }
      }`,
      { actions: [{ name: "create_item", input: "not-json" }] },
    );
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("invalid JSON");
  });

  test("(g) permission middleware blocks unauthorized items per item", async () => {
    provider.records.clear();
    // Anonymous actor (no admin group) — `delete_item` should fail with
    // PERMISSION.DENIED while the create_item call still succeeds.
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "partial") {
          ${BATCH_SELECTION}
        }
      }`,
      {
        actions: [
          { name: "create_item", input: JSON.stringify({ title: "ok" }) },
          { name: "delete_item", input: JSON.stringify({ id: "rec_1" }) },
        ],
      },
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.success).toBe(false);
    expect(batch.succeeded.length).toBe(1);
    expect(batch.failed.length).toBe(1);
    expect(batch.failed[0]?.error.code).toBe("PERMISSION.DENIED");
  });

  test("(i) per-item `input` is optional, omitted defaults to {} (REST parity)", async () => {
    // Regression for CodeRabbit major (PR #234 review): the REST batch
    // endpoint normalizes `{ name }` (no input) to `{ name, input: {} }`.
    // The GraphQL boundary previously required `input` as NonNull, which
    // broke parity for actions that take no input. After this fix, omitting
    // `input` works the same way.
    provider.records.clear();
    const result = await gql(
      `mutation Run($actions: [BatchActionInputItem!]!) {
        batch_actions(actions: $actions, strategy: "partial") {
          ${BATCH_SELECTION}
        }
      }`,
      // No `input` field — mirrors REST's `{ name }`-only shape.
      {
        actions: [
          { name: "create_item", input: JSON.stringify({ title: "from-omitted" }) },
          { name: "fail_item" },
        ],
      },
    );
    expect(result.errors).toBeUndefined();
    const batch = result.data?.batch_actions;
    expect(batch).toBeDefined();
    if (!batch) return;
    // create_item succeeded (it does require title); fail_item ran with `{}`
    // input and threw (consistent with the REST contract).
    expect(batch.succeeded.length).toBe(1);
    expect(batch.failed.length).toBe(1);
    expect(batch.failed[0]?.index).toBe(1);
  });

  test("(h) production mode sanitizes per-item error.message but preserves error.code", async () => {
    // Regression for codex P1: in production, raw handler / driver exception
    // text must NOT leak through GraphQL `failed[*].error.message`. Codes
    // and field locators stay intact so clients can still distinguish
    // validation vs. permission failures. Mirrors the REST handler's
    // `sanitizeBatchResult` in `routes/action-api.ts`.
    provider.records.clear();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await gql(
        `mutation Run($actions: [BatchActionInputItem!]!) {
          batch_actions(actions: $actions, strategy: "partial") {
            ${BATCH_SELECTION}
          }
        }`,
        {
          actions: [
            { name: "create_item", input: JSON.stringify({ title: "ok" }) },
            { name: "fail_item", input: JSON.stringify({}) },
          ],
        },
      );
      expect(result.errors).toBeUndefined();
      const batch = result.data?.batch_actions;
      expect(batch).toBeDefined();
      if (!batch) return;
      expect(batch.success).toBe(false);
      expect(batch.failed.length).toBe(1);
      // The fixture's failItem throws `new Error("intentional failure")`.
      // Production mode must replace that text but keep the code intact.
      expect(batch.failed[0]?.error.message).not.toContain("intentional failure");
      expect(batch.failed[0]?.error.message).toBe("Action execution failed");
      expect(typeof batch.failed[0]?.error.code).toBe("string");
      expect((batch.failed[0]?.error.code as string).length).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
