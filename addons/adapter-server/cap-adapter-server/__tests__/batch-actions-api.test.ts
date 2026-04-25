/**
 * REST `POST /api/actions/batch` integration tests (Spec 16 §3.1).
 *
 * Covers route registration order (the parametric `:name` route MUST NOT
 * capture `batch`), body validation, and the structured BatchActionsResult
 * envelope produced by `CommandLayer.executeBatch`.
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

// Snapshot-aware in-memory provider so we can verify rollback behavior under
// `all_or_nothing`. InMemoryStore alone has no rollback semantics, so we
// pair a custom DataProvider with a fake TransactionManager.
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

const commandLayer = createCommandLayer({ executor });
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

const graphqlSchema = buildGraphQLSchema([itemSchema]);
const app = createServer(graphqlSchema, {
  executor,
  commandLayer,
  transactionManager: txManager,
});
const port = 4030;

const baseUrl = () => `http://localhost:${port}`;

async function postJSON(path: string, body: unknown, init?: RequestInit) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, raw: text };
}

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

describe("POST /api/actions/batch", () => {
  test("(a) valid partial batch returns 200 with structured BatchActionsResult", async () => {
    provider.records.clear();
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "partial",
      actions: [
        { name: "create_item", input: { title: "X" } },
        { name: "create_item", input: { title: "Y" } },
      ],
    });
    expect(status).toBe(200);
    expect(body?.success).toBe(true);
    expect(body?.strategy).toBe("partial");
    expect(Array.isArray(body?.succeeded)).toBe(true);
    expect((body?.succeeded as unknown[]).length).toBe(2);
    expect((body?.failed as unknown[]).length).toBe(0);
    expect((body?.summary as Record<string, number>).total).toBe(2);
  });

  test("(b) missing actions field → 400", async () => {
    const { status, body } = await postJSON("/api/actions/batch", { strategy: "partial" });
    expect(status).toBe(400);
    expect(body?.success).toBe(false);
  });

  test("(c) actions not an array → 400", async () => {
    const { status, body } = await postJSON("/api/actions/batch", {
      actions: "not an array",
    });
    expect(status).toBe(400);
    expect(body?.success).toBe(false);
  });

  test("(c2) array-valued input → 400 (object spread would silently rewrite arrays)", async () => {
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "partial",
      actions: [{ name: "create_item", input: [] }],
    });
    expect(status).toBe(400);
    expect(body?.success).toBe(false);
    const message = (body?.error as { message?: string } | undefined)?.message ?? "";
    expect(message).toContain("actions[0].input must be an object when present.");
  });

  test("(d) unknown strategy → 400", async () => {
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "fast",
      actions: [{ name: "create_item", input: { title: "x" } }],
    });
    expect(status).toBe(400);
    expect(body?.success).toBe(false);
  });

  test("(e) empty actions array → 200 with structured BATCH_EMPTY failure", async () => {
    // Empty body validation now happens in the engine layer (returns
    // structured failure); request shape is valid, so HTTP is still 200.
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "partial",
      actions: [],
    });
    expect(status).toBe(200);
    expect(body?.success).toBe(false);
    const failed = body?.failed as Array<{ error: { code: string } }>;
    expect(failed[0]?.error.code).toBe("BATCH_EMPTY");
  });

  test("(f) all_or_nothing rollback returns 200 with rolledBack populated", async () => {
    provider.records.clear();
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "all_or_nothing",
      actions: [
        { name: "create_item", input: { title: "A" } },
        { name: "fail_item", input: {} },
      ],
    });
    expect(status).toBe(200);
    expect(body?.success).toBe(false);
    expect(body?.strategy).toBe("all_or_nothing");
    const rolledBack = body?.rolledBack as unknown[];
    expect(rolledBack.length).toBe(1);
    expect(provider.records.size).toBe(0);
  });

  test("(h) production mode sanitizes per-item error messages", async () => {
    // The `fail_item` handler throws a recognizable internal message; in
    // production mode we expect the per-item `error.message` to be replaced
    // with the generic placeholder while `code` is preserved.
    provider.records.clear();
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { status, body } = await postJSON("/api/actions/batch", {
        strategy: "partial",
        actions: [
          { name: "create_item", input: { title: "ok" } },
          { name: "fail_item", input: {} },
        ],
      });
      expect(status).toBe(200);
      expect(body?.success).toBe(false);
      const failed = body?.failed as Array<{ error: { code: string; message: string } }>;
      expect(failed.length).toBe(1);
      expect(failed[0]?.error.message).toBe("Action execution failed");
      // The internal message MUST NOT leak.
      expect(failed[0]?.error.message).not.toContain("intentional failure");
      // Codes are still informative.
      expect(typeof failed[0]?.error.code).toBe("string");
    } finally {
      if (prevEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevEnv;
      }
    }
  });

  test("(g) /api/actions/batch is NOT captured by /api/actions/:name", async () => {
    // Sanity check: posting to `/api/actions/batch` reaches the batch handler
    // (validates the body shape and rejects an empty `actions` array via
    // structured failure) — NOT the single-action handler, which would have
    // returned a 404 with "Action 'batch' not found".
    const { status, body } = await postJSON("/api/actions/batch", {
      strategy: "partial",
      actions: [],
    });
    expect(status).toBe(200);
    // Single-action handler returns `{ success, error: { code: "ACTION.EXECUTION.FAILED" } }`,
    // batch handler returns BatchActionsResult shape with `failed` array.
    expect(Array.isArray(body?.failed)).toBe(true);
    expect("strategy" in (body ?? {})).toBe(true);
  });
});
