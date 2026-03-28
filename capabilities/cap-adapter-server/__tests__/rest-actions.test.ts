/**
 * REST Action endpoint integration tests.
 *
 * Covers HTTP status code mapping (resolveStatusCode) and response body
 * structure per spec 16 §2.3.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const itemSchema: SchemaDefinition = {
  name: "item",
  label: "Item",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", label: "Amount" },
  },
};

/** A simple action that succeeds */
const successAction: ActionDefinition = {
  name: "do_success",
  schema: "item",
  label: "Succeed",
  policy: { mode: "sync", transaction: false },
  handler: async (ctx) => {
    return { message: "ok", input: ctx.input };
  },
};

/** An action whose handler throws an error */
const throwAction: ActionDefinition = {
  name: "do_throw",
  schema: "item",
  label: "Throw",
  policy: { mode: "sync", transaction: false },
  handler: async () => {
    throw new Error("Something went wrong");
  },
};

/** An action restricted to the "manager" role */
const restrictedAction: ActionDefinition = {
  name: "do_restricted",
  schema: "item",
  label: "Restricted",
  policy: { mode: "sync", transaction: false },
  permissions: {
    groups: ["manager"],
  },
  handler: async () => ({ ok: true }),
};

/** An action with required input fields */
const validatedAction: ActionDefinition = {
  name: "do_validated",
  schema: "item",
  label: "Validated",
  policy: { mode: "sync", transaction: false },
  input: {
    title: { type: "string", required: true, label: "Title" },
  },
  handler: async (ctx) => ({ title: ctx.input.title }),
};

/** An action that is not exposed over HTTP */
const internalOnlyAction: ActionDefinition = {
  name: "do_internal",
  schema: "item",
  label: "Internal Only",
  policy: { mode: "sync", transaction: false },
  exposure: { http: false, internal: true },
  handler: async () => ({ ok: true }),
};

// ── Server setup ──────────────────────────────────────────

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const executor = createActionExecutor({
  dataProvider: store,
  executionLogger,
});

// Register all test actions
for (const action of [
  successAction,
  throwAction,
  restrictedAction,
  validatedAction,
  internalOnlyAction,
]) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([itemSchema]);
const app = createServer(graphqlSchema, { executor });
const port = 4010;

function actionUrl(name: string): string {
  return `http://localhost:${port}/api/actions/${name}`;
}

async function postAction(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(actionUrl(name), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ── Lifecycle ─────────────────────────────────────────────

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

// ── Tests ─────────────────────────────────────────────────

describe("REST action endpoint — status codes", () => {
  test("(a) successful action → 200 + { success, data, meta }", async () => {
    const { status, body } = await postAction("do_success", { foo: "bar" });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.meta).toBeDefined();
    const meta = body.meta as Record<string, unknown>;
    expect(meta.executionId).toBeDefined();
    expect(typeof meta.executionId).toBe("string");

    // Verify data payload
    const data = body.data as Record<string, unknown>;
    expect(data.message).toBe("ok");
  });

  test("(b) action not found → 404", async () => {
    const { status, body } = await postAction("nonexistent_action", {});

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("ACTION.EXECUTION.FAILED");
    expect((err.message as string).toLowerCase()).toContain("not found");
    expect(body.meta).toBeDefined();
  });

  test("(c) permission denied → 403", async () => {
    // Anonymous actor has no groups, but the action requires "manager"
    const { status, body } = await postAction("do_restricted", {});

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("ACTION.EXECUTION.FAILED");
    expect(err.message as string).toContain("does not belong to");
  });

  test("(d) input validation failure → 400", async () => {
    // Required field "title" is missing
    const { status, body } = await postAction("do_validated", {});

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("ACTION.EXECUTION.FAILED");
  });

  test("(e) handler throws exception → 422", async () => {
    const { status, body } = await postAction("do_throw", {});

    expect(status).toBe(422);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("ACTION.EXECUTION.FAILED");
    expect(err.message).toBe("Something went wrong");
  });

  test("(f) exposure blocked (http: false) → 403", async () => {
    const { status, body } = await postAction("do_internal", {});

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("not exposed");
  });
});

describe("REST action endpoint — response structure", () => {
  test("success response has { success: true, data, meta } shape", async () => {
    const { body } = await postAction("do_success", { x: 1 });

    expect(body).toHaveProperty("success", true);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
    // Should NOT have error key on success
    expect(body).not.toHaveProperty("error");
  });

  test("error response has { success: false, error: { code, message }, meta } shape", async () => {
    const { body } = await postAction("nonexistent_action", {});

    expect(body).toHaveProperty("success", false);
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("meta");
    const err = body.error as Record<string, unknown>;
    expect(err).toHaveProperty("code");
    expect(err).toHaveProperty("message");
    // Should NOT have data key on error
    expect(body).not.toHaveProperty("data");
  });

  test("no executor configured → 500 with system error", async () => {
    // Create a server without an executor
    const bareSchema = buildGraphQLSchema([]);
    const bareApp = createServer(bareSchema);
    const barePort = 4011;
    bareApp.listen(barePort);

    try {
      const res = await fetch(`http://localhost:${barePort}/api/actions/anything`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe("SYSTEM.SERVER.NOT_CONFIGURED");
      expect(err.type).toBe("system");
    } finally {
      bareApp.stop();
    }
  });
});

describe("REST action endpoint — input passthrough", () => {
  test("input body is forwarded to action handler", async () => {
    const { body } = await postAction("do_success", {
      title: "Test",
      amount: 42,
    });

    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    const input = data.input as Record<string, unknown>;
    expect(input.title).toBe("Test");
    expect(input.amount).toBe(42);
  });

  test("validation passes when required fields are present", async () => {
    const { status, body } = await postAction("do_validated", {
      title: "Provided",
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.title).toBe("Provided");
  });
});
