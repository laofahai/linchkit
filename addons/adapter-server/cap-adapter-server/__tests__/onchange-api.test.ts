/**
 * REST onchange endpoint integration tests (Spec 64).
 *
 * Verifies the full request flow:
 *   - CommandLayer pipeline with skipActionSlots
 *   - Entity + onchange definition lookup
 *   - Permission middleware denial surfacing as 403
 *   - Request body validation (400 / 404)
 *   - Happy-path response shape { updates, warnings }
 */

import { beforeAll, describe, expect, test } from "bun:test";
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
  name: "purchase_line",
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
        unit_price: await ctx.lookup("product", ctx.value as string, "price"),
        description: await ctx.lookup("product", ctx.value as string, "description"),
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

const plainEntity: EntityDefinition = {
  name: "plain",
  fields: {
    title: { type: "string" },
  },
};

// Onchange evaluator uses this data provider for lookups.
const store = new InMemoryStore();

// Seed a product used by lookups.
await store.create("product", { id: "p1", price: 29.99, description: "Widget" });

// ── Servers ───────────────────────────────────────────────

function buildServer(options: {
  permissionDeny?: boolean;
  permissionDenyMessage?: string;
  withEvaluator?: boolean;
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

  const evaluator = options.withEvaluator
    ? createOnchangeEvaluator({ entityRegistry, dataProvider: store })
    : undefined;

  const graphqlSchema = buildGraphQLSchema([lineEntity, plainEntity]);
  const app = createServer(graphqlSchema, {
    executor,
    commandLayer,
    entityRegistry,
    onchangeEvaluator: evaluator,
  });
  return app;
}

const BASE = "http://local.test";
let happyApp: ReturnType<typeof buildServer>;
let denyApp: ReturnType<typeof buildServer>;
let leakyDenyApp: ReturnType<typeof buildServer>;

beforeAll(() => {
  happyApp = buildServer({ withEvaluator: true });
  denyApp = buildServer({ withEvaluator: true, permissionDeny: true });
  // A permission middleware that echoes an entity-specific denial string —
  // exactly the kind of side-channel Non-blocker 4 canonicalizes away.
  leakyDenyApp = buildServer({
    withEvaluator: true,
    permissionDeny: true,
    permissionDenyMessage: "forbidden: entity admin_secret",
  });
});

async function postOnchange(
  app: ReturnType<typeof buildServer>,
  entityName: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(
    new Request(`${BASE}/api/entities/${entityName}/onchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ── Tests ─────────────────────────────────────────────────

describe("POST /api/entities/:name/onchange", () => {
  test("happy path returns { updates, warnings } with chained subtotal cascade", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1", quantity: 2 },
    });
    expect(status).toBe(200);
    // product_id -> unit_price, description (29.99, "Widget")
    // unit_price triggers quantity,unit_price -> subtotal (2 * 29.99)
    const updates = body.updates as Record<string, unknown>;
    expect(updates.unit_price).toBe(29.99);
    expect(updates.description).toBe("Widget");
    expect(updates.subtotal).toBeCloseTo(59.98, 5);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  test("comma-separated trigger (quantity,unit_price) updates subtotal", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "quantity",
      values: { quantity: 4, unit_price: 5 },
    });
    expect(status).toBe(200);
    expect(body.updates).toEqual({ subtotal: 20 });
  });

  test("400 when changedField is missing", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      values: { product_id: "p1" },
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test("400 when changedField is not a known field on the entity", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "does_not_exist",
      values: {},
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test("400 when changedField is not a string", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: 42,
      values: {},
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test("404 when entity does not exist (with permission allowed)", async () => {
    // Permission slot is a no-op allow_all — with authorization in hand, the
    // evaluator DOES reveal that the entity is missing. Only unauthenticated
    // callers see a uniform 403 (see Finding 1 tests below).
    const { status, body } = await postOnchange(happyApp, "ghost", {
      changedField: "x",
      values: {},
    });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test("404 when entity has no onchange definition", async () => {
    const { status, body } = await postOnchange(happyApp, "plain", {
      changedField: "title",
      values: { title: "hi" },
    });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test("404 when changedField exists on entity but has no onchange hook", async () => {
    // `description` is defined on purchase_line but no hook is registered
    // against it. Spec 64 §4.1 mandates this returns 404 (not an empty 200).
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "description",
      values: { description: "x" },
    });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.message as string).toContain("no onchange hook");
  });

  test("403 when permission middleware denies the request", async () => {
    const { status, body } = await postOnchange(denyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1" },
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    // Non-blocker 4 — 403 payload is the fixed canonical envelope, NOT the
    // middleware-supplied "Actor lacks read permission on entity" text.
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("AUTHZ_DENIED");
    expect(err.message).toBe("Access denied");
    // Sanity: middleware detail does NOT leak.
    expect(err.message as string).not.toContain("read permission");
  });

  test("response shape includes updates (record) and warnings (array)", async () => {
    const { body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1" },
    });
    expect(body).toHaveProperty("updates");
    expect(body).toHaveProperty("warnings");
    expect(typeof body.updates).toBe("object");
    expect(Array.isArray(body.warnings)).toBe(true);
  });
});

// ── Finding 1: auth before existence ──────────────────────

describe("POST /api/entities/:name/onchange — authorize before revealing existence (Finding 1)", () => {
  test("probe against non-existent entity with denying permission returns 403 (not 404)", async () => {
    // The deny-all server rejects at the permission slot. The caller must
    // NOT be able to tell from the response whether "ghost" exists — they
    // only learn that they're not authorized.
    const { status, body } = await postOnchange(denyApp, "ghost", {
      changedField: "x",
      values: {},
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    // Must not leak entity-existence information.
    expect(JSON.stringify(err)).not.toContain("not found");
    expect(JSON.stringify(err)).not.toContain("no onchange");
  });

  test("probe against real entity with denying permission returns 403", async () => {
    const { status, body } = await postOnchange(denyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1" },
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test("probe with missing changedField on denying permission still returns 403 (no 400 leak)", async () => {
    // Previously the 400 branch for missing changedField ran before the
    // permission slot, letting an unauthenticated caller distinguish "bad
    // request shape" from "entity does not exist" vs "permission denied".
    // Now auth runs first so the answer is always 403.
    const { status } = await postOnchange(denyApp, "purchase_line", {
      values: {},
    });
    expect(status).toBe(403);
  });

  test("probe with malformed values on denying permission still returns 403 (auth wins)", async () => {
    const { status } = await postOnchange(denyApp, "purchase_line", {
      changedField: "product_id",
      values: "not an object",
    });
    expect(status).toBe(403);
  });
});

// ── Non-blocker 4: canonical 403 envelope ─────────────────

describe("POST /api/entities/:name/onchange — canonical 403 envelope (Non-blocker 4)", () => {
  test("403 body is the fixed AUTHZ_DENIED envelope, middleware detail does not leak", async () => {
    // `leakyDenyApp` uses a permission middleware whose denial message encodes
    // entity-specific text ("forbidden: entity admin_secret"). Echoing that
    // into the response body would let an attacker enumerate entities via
    // varying error strings. The canonical envelope collapses every 403 into
    // the same payload.
    const { status, body } = await postOnchange(leakyDenyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1" },
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("AUTHZ_DENIED");
    expect(err.message).toBe("Access denied");

    // Full payload sanity — no middleware text surfaces anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("admin_secret");
    expect(serialized).not.toContain("forbidden:");
    expect(serialized).not.toContain("entity admin_secret");
  });

  test("403 envelope is identical across different entities (no side channel)", async () => {
    // Probing two different entities must return byte-identical 403 bodies so
    // no observable difference lets a caller distinguish one entity from
    // another via the response text.
    const a = await postOnchange(leakyDenyApp, "purchase_line", {
      changedField: "product_id",
      values: {},
    });
    const b = await postOnchange(leakyDenyApp, "ghost_entity_xyz", {
      changedField: "anything",
      values: {},
    });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(a.body).toEqual(b.body);
  });
});

// ── Finding 2: reject malformed `values` ──────────────────

describe("POST /api/entities/:name/onchange — malformed values (Finding 2)", () => {
  test("values as array → 400 with MALFORMED_VALUES code", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: [],
    });
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("values as string → 400 with MALFORMED_VALUES code", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: "not an object",
    });
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("values as null → 400 with MALFORMED_VALUES code", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: null,
    });
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("values as number → 400 with MALFORMED_VALUES code", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: 42,
    });
    expect(status).toBe(400);
    const err = body.error as Record<string, unknown>;
    expect(err.code).toBe("INVALID_REQUEST.MALFORMED_VALUES");
  });

  test("values as plain object → proceeds normally", async () => {
    const { status, body } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
      values: { product_id: "p1", quantity: 1 },
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("updates");
    expect(body).toHaveProperty("warnings");
  });

  test("values omitted entirely → defaults to {} and proceeds", async () => {
    // `values` is optional — the old behavior of treating absent as `{}` is
    // preserved. Only explicitly-wrong shapes trigger MALFORMED_VALUES.
    const { status } = await postOnchange(happyApp, "purchase_line", {
      changedField: "product_id",
    });
    expect(status).toBe(200);
  });
});

describe("onchange evaluator wiring via runtime context", () => {
  // Smoke-test: construct the evaluator the same way dev.ts / capability.ts do
  // — from runtime `entityRegistry` + `dataProvider`. A stock install that
  // forgets to pass `onchangeEvaluator` should still wire correctly when this
  // code path is used.
  test("createOnchangeEvaluator can be built from a shared runtime registry + data provider", async () => {
    const { createRuntimeContext } = await import("../src/runtime-context");
    const runtime = createRuntimeContext({
      entities: [lineEntity, plainEntity],
    });
    // Seed the same product fixture into the shared store
    if (runtime.dataProvider instanceof InMemoryStore) {
      await runtime.dataProvider.create("product", {
        id: "p2",
        price: 7,
        description: "Gadget",
      });
    }
    const evaluator = createOnchangeEvaluator({
      entityRegistry: runtime.entityRegistry,
      dataProvider: runtime.dataProvider,
    });
    const result = await evaluator.evaluate({
      entityName: "purchase_line",
      changedField: "product_id",
      values: { product_id: "p2", quantity: 3 },
      actor: { type: "human", id: "u1", groups: ["user"] },
    });
    expect(result.updates.unit_price).toBe(7);
    expect(result.updates.description).toBe("Gadget");
    expect(result.updates.subtotal).toBe(21);
  });
});
