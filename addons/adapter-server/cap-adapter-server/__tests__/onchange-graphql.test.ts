/**
 * GraphQL `<entity>_onchange` mutation integration tests (Spec 64 §4.2).
 *
 * Covers the full GraphQL flow:
 *   - Auto-generation only fires for entities with an onchange map
 *   - CommandLayer runs (auth/permission/tenant) before the evaluator
 *   - Permission denial collapses to canonical AUTHZ_DENIED (no enumeration)
 *   - Malformed values arg → INVALID_REQUEST.MALFORMED_VALUES
 *   - Successful evaluation returns { updates: <json>, warnings: [...] }
 *   - OnchangeEvaluatorError propagates with a stable extension code
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  createEntityRegistry,
  createOnchangeEvaluator,
  InMemoryStore,
  PipelineError,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const lineEntity: EntityDefinition = {
  name: "purchase_line_gql",
  fields: {
    product_id: { type: "string", label: "Product" },
    unit_price: { type: "number", label: "Unit Price" },
    description: { type: "string", label: "Description" },
    quantity: { type: "number", label: "Quantity" },
    subtotal: { type: "number", label: "Subtotal" },
  },
  onchange: {
    product_id: {
      updates: ["unit_price", "description"],
      compute: async (ctx) => ({
        unit_price: await ctx.lookup("product_gql", ctx.value as string, "price"),
        description: await ctx.lookup("product_gql", ctx.value as string, "description"),
      }),
    },
    "quantity,unit_price": {
      updates: ["subtotal"],
      compute: (ctx) => ({
        subtotal: ((ctx.values.quantity as number) ?? 0) * ((ctx.values.unit_price as number) ?? 0),
      }),
    },
  },
};

// Entity with NO onchange map — its `<name>_onchange` field must NOT appear in the schema.
const plainEntity: EntityDefinition = {
  name: "plain_gql",
  fields: {
    title: { type: "string" },
  },
};

// Onchange evaluator uses this provider for lookups.
const store = new InMemoryStore();
await store.create("product_gql", { id: "pg1", price: 49.5, description: "Sprocket" });

// ── Server harness ────────────────────────────────────────

function buildServer(options: {
  permissionDeny?: boolean;
  permissionDenyMessage?: string;
  port: number;
}) {
  const entityRegistry = createEntityRegistry();
  entityRegistry.register(lineEntity);
  entityRegistry.register(plainEntity);

  const executor = createActionExecutor({ dataProvider: store });
  const commandLayer = createCommandLayer({ executor });

  if (options.permissionDeny) {
    const message = options.permissionDenyMessage ?? "Actor lacks read permission on entity";
    commandLayer.use({
      name: "deny_all",
      slot: "permission",
      handler: async () => {
        throw new PipelineError(message, "authz.action.denied");
      },
    });
  } else {
    // Non-action dispatch (`skipActionSlots`) requires a permission middleware
    // (fail-closed guard). Register a no-op allow-all stub for the happy path.
    commandLayer.use({
      name: "allow_all",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });
  }

  const evaluator = createOnchangeEvaluator({ entityRegistry, dataProvider: store });

  const graphqlSchema = buildGraphQLSchema([lineEntity, plainEntity], {
    executor,
    commandLayer,
    onchangeEvaluator: evaluator,
  });

  const app = createServer(graphqlSchema, { executor, commandLayer, entityRegistry });
  app.listen(options.port);
  return app;
}

// Server with NO evaluator wired — onchange mutation should be omitted entirely.
function buildServerWithoutEvaluator(port: number) {
  const entityRegistry = createEntityRegistry();
  entityRegistry.register(lineEntity);

  const executor = createActionExecutor({ dataProvider: store });
  const commandLayer = createCommandLayer({ executor });
  commandLayer.use({
    name: "allow_all",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });

  const graphqlSchema = buildGraphQLSchema([lineEntity], { executor, commandLayer });
  const app = createServer(graphqlSchema, { executor, commandLayer, entityRegistry });
  app.listen(port);
  return app;
}

const happyPort = 4310;
const denyPort = 4311;
const leakyDenyPort = 4312;
const noEvaluatorPort = 4313;
let happyApp: ReturnType<typeof buildServer>;
let denyApp: ReturnType<typeof buildServer>;
let leakyDenyApp: ReturnType<typeof buildServer>;
let noEvaluatorApp: ReturnType<typeof buildServer>;

beforeAll(() => {
  happyApp = buildServer({ port: happyPort });
  denyApp = buildServer({ port: denyPort, permissionDeny: true });
  leakyDenyApp = buildServer({
    port: leakyDenyPort,
    permissionDeny: true,
    permissionDenyMessage: "forbidden: entity admin_secret",
  });
  noEvaluatorApp = buildServerWithoutEvaluator(noEvaluatorPort);
});

afterAll(() => {
  happyApp.stop();
  denyApp.stop();
  leakyDenyApp.stop();
  noEvaluatorApp.stop();
});

// ── Helpers ──────────────────────────────────────────────

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

async function gql(port: number, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GraphQLResponse;
}

const ONCHANGE_MUTATION = /* GraphQL */ `
  mutation Onchange($field: String!, $values: String!) {
    purchase_line_gql_onchange(changedField: $field, values: $values) {
      updates
      warnings
    }
  }
`;

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL `<entity>_onchange` auto-generation", () => {
  test("schema exposes purchase_line_gql_onchange but NOT plain_gql_onchange", async () => {
    const introspection = await gql(
      happyPort,
      /* GraphQL */ `
        {
          __type(name: "Mutation") {
            fields {
              name
            }
          }
        }
      `,
    );
    const fields = (
      introspection.data?.__type as { fields: Array<{ name: string }> } | null
    )?.fields.map((f) => f.name);
    expect(fields).toContain("purchase_line_gql_onchange");
    // Entity without onchange map must not get a mutation.
    expect(fields).not.toContain("plain_gql_onchange");
  });

  test("mutation is omitted entirely when no evaluator is wired", async () => {
    const introspection = await gql(
      noEvaluatorPort,
      /* GraphQL */ `
        {
          __type(name: "Mutation") {
            fields {
              name
            }
          }
        }
      `,
    );
    const fields = (
      introspection.data?.__type as { fields: Array<{ name: string }> } | null
    )?.fields.map((f) => f.name);
    expect(fields).not.toContain("purchase_line_gql_onchange");
  });

  test("OnchangeResponse type is exported with updates + warnings shape", async () => {
    const introspection = await gql(
      happyPort,
      /* GraphQL */ `
        {
          __type(name: "OnchangeResponse") {
            fields {
              name
              type {
                kind
                ofType {
                  name
                }
              }
            }
          }
        }
      `,
    );
    const t = introspection.data?.__type as {
      fields: Array<{ name: string; type: { kind: string; ofType?: { name?: string } } }>;
    } | null;
    const fieldNames = t?.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(["updates", "warnings"]);
  });
});

describe("GraphQL `<entity>_onchange` happy path", () => {
  test("returns updates JSON + warnings array with chained subtotal cascade", async () => {
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: JSON.stringify({ product_id: "pg1", quantity: 3 }),
    });
    expect(result.errors).toBeUndefined();
    const payload = result.data?.purchase_line_gql_onchange as {
      updates: string;
      warnings: string[];
    };
    expect(typeof payload.updates).toBe("string");
    const updates = JSON.parse(payload.updates) as Record<string, unknown>;
    expect(updates.unit_price).toBe(49.5);
    expect(updates.description).toBe("Sprocket");
    expect(updates.subtotal).toBeCloseTo(148.5, 5);
    expect(Array.isArray(payload.warnings)).toBe(true);
  });

  test("comma-separated trigger updates only the cascaded field", async () => {
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "quantity",
      values: JSON.stringify({ quantity: 4, unit_price: 5 }),
    });
    expect(result.errors).toBeUndefined();
    const payload = result.data?.purchase_line_gql_onchange as {
      updates: string;
      warnings: string[];
    };
    expect(JSON.parse(payload.updates)).toEqual({ subtotal: 20 });
  });
});

describe("GraphQL `<entity>_onchange` validation", () => {
  test("malformed JSON in values arg returns INVALID_REQUEST.MALFORMED_VALUES", async () => {
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: "not-json",
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("non-object JSON in values arg (array) returns MALFORMED_VALUES", async () => {
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: JSON.stringify([1, 2, 3]),
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("oversized values arg returns VALUES_TOO_LARGE", async () => {
    // 10_001 chars of whitespace is still valid JSON (`"x...x"`) but exceeds the cap.
    const huge = `"${"x".repeat(10_001)}"`;
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: huge,
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("INVALID_REQUEST.VALUES_TOO_LARGE");
  });

  test("changedField with no registered hook surfaces ONCHANGE.NO_HOOK_FOR_FIELD", async () => {
    // `description` is a known field but has no hook registered.
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "description",
      values: JSON.stringify({ description: "x" }),
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("ONCHANGE.NO_HOOK_FOR_FIELD");
  });

  test("changedField unknown to the entity surfaces ONCHANGE.FIELD_UNKNOWN", async () => {
    const result = await gql(happyPort, ONCHANGE_MUTATION, {
      field: "does_not_exist",
      values: JSON.stringify({}),
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("ONCHANGE.FIELD_UNKNOWN");
  });
});

describe("GraphQL `<entity>_onchange` permission denial canonicalization", () => {
  test("denied permission collapses to AUTHZ_DENIED with generic message", async () => {
    const result = await gql(denyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: JSON.stringify({ product_id: "pg1" }),
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("AUTHZ_DENIED");
    expect(result.errors?.[0]?.message).toBe("Access denied");
  });

  test("middleware-supplied entity-specific denial text does NOT leak through GraphQL", async () => {
    // The leaky middleware sends "forbidden: entity admin_secret". The
    // resolver must canonicalize the response so attackers cannot enumerate
    // entities by reading varying error strings.
    const result = await gql(leakyDenyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: JSON.stringify({ product_id: "pg1" }),
    });
    expect(result.errors?.[0]?.message).toBe("Access denied");
    expect(result.errors?.[0]?.message).not.toContain("admin_secret");
    expect(JSON.stringify(result.errors)).not.toContain("admin_secret");
  });

  test("auth runs BEFORE values validation — denying side sees AUTHZ_DENIED, not MALFORMED_VALUES", async () => {
    // Codex Round-1 P3 — uniform-denial property. An unauthorized caller
    // sending malformed `values` must get the same canonical AUTHZ_DENIED
    // response as a request with valid input shape; otherwise the caller
    // could distinguish "endpoint exists, request rejected at validation"
    // from "endpoint denied entirely" and enumerate which entities have
    // onchange hooks.
    const result = await gql(denyPort, ONCHANGE_MUTATION, {
      field: "product_id",
      values: "definitely not json",
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("AUTHZ_DENIED");
    expect(result.errors?.[0]?.extensions?.code).not.toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });
});

// ── Codex Round-1 P2: non-auth pipeline failures retain their semantics ──

describe("GraphQL `<entity>_onchange` non-auth pipeline failures", () => {
  test("rate_limit pipeline failure surfaces the original code, NOT canonical AUTHZ_DENIED", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lineEntity);
    const executor = createActionExecutor({ dataProvider: store });
    const commandLayer = createCommandLayer({ executor });
    commandLayer.use({
      name: "rate_limit_throttle",
      slot: "permission",
      handler: async () => {
        throw new PipelineError("Too many requests, retry later", "rate_limit.exceeded");
      },
    });
    const evaluator = createOnchangeEvaluator({ entityRegistry, dataProvider: store });
    const schema = buildGraphQLSchema([lineEntity], {
      executor,
      commandLayer,
      onchangeEvaluator: evaluator,
    });
    const port = 4314;
    const app = createServer(schema, { executor, commandLayer, entityRegistry });
    app.listen(port);
    try {
      const result = await gql(port, ONCHANGE_MUTATION, {
        field: "product_id",
        values: JSON.stringify({ product_id: "pg1" }),
      });
      // Must NOT collapse to AUTHZ_DENIED — clients need to recognize
      // throttling so they can backoff/retry. The original error code
      // is preserved verbatim in extensions.
      expect(result.errors?.[0]?.extensions?.code).toBe("rate_limit.exceeded");
      expect(result.errors?.[0]?.extensions?.code).not.toBe("AUTHZ_DENIED");
      // The structured message reaches the client (auth gates already passed,
      // so non-auth failure detail is safe to surface).
      expect(result.errors?.[0]?.message).toBe("Too many requests, retry later");
    } finally {
      app.stop();
    }
  });
});

// ── Codex Round-3 P2: post-auth actor reaches the evaluator ──

describe("GraphQL `<entity>_onchange` post-auth actor propagation", () => {
  test("auth middleware that enriches actor.groups is honored by evaluator", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lineEntity);
    const executor = createActionExecutor({ dataProvider: store });
    const commandLayer = createCommandLayer({ executor });
    // Auth middleware that hydrates the actor's roles (e.g. fetches DB
    // groups). The evaluator must observe this enrichment, not the bare
    // actor that arrived in the GraphQL context.
    commandLayer.use({
      name: "hydrate_groups",
      slot: "auth",
      handler: async (c, next) => {
        c.actor = {
          ...c.actor,
          groups: [...(c.actor.groups ?? []), "hydrated-admin"],
        };
        await next();
      },
    });
    commandLayer.use({
      name: "allow_all",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });
    let capturedActor: { id?: string; groups?: string[] } | undefined;
    const spyEvaluator = {
      evaluate: async (args: { actor: { id?: string; groups?: string[] } }) => {
        capturedActor = args.actor;
        return { updates: {}, warnings: [] };
      },
    };
    const schema = buildGraphQLSchema([lineEntity], {
      executor,
      commandLayer,
      onchangeEvaluator: spyEvaluator,
    });
    const port = 4317;
    const app = createServer(schema, { executor, commandLayer, entityRegistry });
    app.listen(port);
    try {
      const result = await gql(port, ONCHANGE_MUTATION, {
        field: "product_id",
        values: JSON.stringify({ product_id: "pg1" }),
      });
      expect(result.errors).toBeUndefined();
      expect(capturedActor?.groups).toContain("hydrated-admin");
    } finally {
      app.stop();
    }
  });
});

// ── Codex Round-3 P3: internalSchemas filter applies to onchange too ──

describe("GraphQL `<entity>_onchange` internalSchemas filter", () => {
  test("entity in internalSchemas does NOT get an auto-generated onchange mutation", async () => {
    const internalEntity: EntityDefinition = {
      name: "system_internal_gql",
      fields: { trigger: { type: "string" }, result: { type: "string" } },
      onchange: {
        trigger: {
          updates: ["result"],
          compute: () => ({ result: "computed" }),
        },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(internalEntity);
    const executor = createActionExecutor({ dataProvider: store });
    const commandLayer = createCommandLayer({ executor });
    commandLayer.use({
      name: "allow_all",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });
    const evaluator = createOnchangeEvaluator({ entityRegistry, dataProvider: store });
    const schema = buildGraphQLSchema([internalEntity], {
      executor,
      commandLayer,
      onchangeEvaluator: evaluator,
      internalSchemas: new Set(["system_internal_gql"]),
    });
    const port = 4318;
    const app = createServer(schema, { executor, commandLayer, entityRegistry });
    app.listen(port);
    try {
      const introspection = await gql(
        port,
        /* GraphQL */ `
          {
            __type(name: "Mutation") {
              fields {
                name
              }
            }
          }
        `,
      );
      const fields = (
        introspection.data?.__type as { fields: Array<{ name: string }> } | null
      )?.fields.map((f) => f.name);
      expect(fields).not.toContain("system_internal_gql_onchange");
    } finally {
      app.stop();
    }
  });
});

// ── Codex Round-2 P2: tenant scope cleared by middleware is honored ──

describe("GraphQL `<entity>_onchange` tenant scope handling", () => {
  test("when tenant middleware clears tenantId, evaluator is called with undefined (no fallback)", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lineEntity);
    const executor = createActionExecutor({ dataProvider: store });
    const commandLayer = createCommandLayer({ executor });
    commandLayer.use({
      name: "allow_all",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });
    // Tenant middleware that intentionally clears the request tenant —
    // simulates a system actor bypass or admin escalation. The resolver
    // MUST honor this and not silently re-inject the request tenant.
    commandLayer.use({
      name: "clear_tenant",
      slot: "tenant",
      handler: async (c, next) => {
        c.tenantId = undefined;
        await next();
      },
    });
    // Spy evaluator: capture the tenantId argument passed to evaluate().
    let capturedTenantId: string | undefined = "SENTINEL_NOT_CALLED";
    const spyEvaluator = {
      evaluate: async (args: { tenantId?: string }) => {
        capturedTenantId = args.tenantId;
        return { updates: {}, warnings: [] };
      },
    };
    const schema = buildGraphQLSchema([lineEntity], {
      executor,
      commandLayer,
      onchangeEvaluator: spyEvaluator,
    });
    const port = 4316;
    const app = createServer(schema, {
      executor,
      commandLayer,
      entityRegistry,
      // Inject a non-null request tenantId so we'd notice fallback if it
      // happened — the resolver receives ctx.tenantId="rt-incoming" yet
      // must pass undefined through because middleware cleared it.
      resolveRequestTenantId: () => "rt-incoming",
    });
    app.listen(port);
    try {
      const result = await gql(port, ONCHANGE_MUTATION, {
        field: "product_id",
        values: JSON.stringify({ product_id: "pg1" }),
      });
      expect(result.errors).toBeUndefined();
      // Evaluator must have been called with undefined tenantId — not
      // "rt-incoming". This proves the resolver respects the middleware's
      // decision to clear scope.
      expect(capturedTenantId).toBeUndefined();
    } finally {
      app.stop();
    }
  });
});

// ── Codex Round-1 P3: unknown evaluator errors do not leak details ──

describe("GraphQL `<entity>_onchange` unexpected evaluator failures", () => {
  test("non-OnchangeEvaluatorError from evaluator returns a fixed generic message", async () => {
    // The OnchangeEvaluator normally catches hook failures internally and
    // converts them to warnings — direct hook throws don't reach the
    // resolver's catch block. To exercise the unknown-error path that
    // Codex Round-1 P3 hardens, we wrap the evaluator with a stub that
    // throws a non-OnchangeEvaluatorError directly. This proves the
    // resolver swallows the message and never echoes it to the client.
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lineEntity);
    const executor = createActionExecutor({ dataProvider: store });
    const commandLayer = createCommandLayer({ executor });
    commandLayer.use({
      name: "allow_all",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });
    // Stub evaluator that always throws a generic Error with secret detail.
    const leakyEvaluator = {
      evaluate: async () => {
        throw new Error("SECRET_INTERNAL_DETAIL: connection to db-replica-3 timed out");
      },
    };
    const schema = buildGraphQLSchema([lineEntity], {
      executor,
      commandLayer,
      onchangeEvaluator: leakyEvaluator,
    });
    const port = 4315;
    const app = createServer(schema, { executor, commandLayer, entityRegistry });
    app.listen(port);
    try {
      const result = await gql(port, ONCHANGE_MUTATION, {
        field: "product_id",
        values: JSON.stringify({ product_id: "pg1" }),
      });
      expect(result.errors?.[0]?.extensions?.code).toBe("ONCHANGE.EVALUATION_FAILED");
      expect(result.errors?.[0]?.message).toBe("Onchange evaluation failed");
      expect(JSON.stringify(result)).not.toContain("SECRET_INTERNAL_DETAIL");
    } finally {
      app.stop();
    }
  });
});
