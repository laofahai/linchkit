/**
 * Onchange authorization SPINE — real route + real cap-permission, one seam.
 *
 * `command-layer.ts` documents a `meta.onchange = { entity }` permission contract:
 * the onchange route (`POST /api/entities/:name/onchange`) dispatches with
 * `skipActionSlots: true` and publishes its authoritative target in `meta.onchange`
 * so the permission middleware can derive an **entity-level READ check** instead of
 * looking up an action named "onchange". The route faithfully populates that meta,
 * but `cap-permission` previously ignored it (gating on the synthetic command name
 * `"<entity>.onchange"` no group grants → silent default-deny / admin-only) — the
 * same producer-fills-meta / consumer-ignores-meta seam #527 fixed for evolution.
 *
 * The sibling `onchange-api.test.ts` drives the real route but with a STUB
 * permission middleware (allow-all / throw-all), so it never proves the REAL
 * `cap-permission` honours `meta.onchange`. This spine fills exactly that gap: it
 * drives the real route through `createServer` behind the REAL `cap-permission`
 * middleware whose decision comes from a REAL `PermissionRegistry` grant, and
 * asserts producer + consumer AGREE on the `meta.onchange.entity` signal:
 *   - an actor with READ access to the entity (`grant.invoice.data.read`) is
 *     allowed and gets the computed onchange result;
 *   - an actor without it is denied (canonical `AUTHZ_DENIED`, 403).
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 */

import { describe, expect, test } from "bun:test";
import { createPermissionMiddlewareRegistration } from "@linchkit/cap-permission";
import type { Actor, EntityDefinition } from "@linchkit/core";
import { definePermissionGroup } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  createEntityRegistry,
  createOnchangeEvaluator,
  InMemoryStore,
  PermissionRegistry,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

const BASE = "http://local.test";

/** A minimal entity with a self-contained onchange hook (no store lookup). */
const invoiceEntity: EntityDefinition = {
  name: "invoice",
  label: "Invoice",
  fields: {
    qty: { type: "number", label: "Qty" },
    unit_price: { type: "number", label: "Unit Price" },
    total: { type: "number", label: "Total" },
  },
  onchange: {
    "qty,unit_price": {
      updates: ["total"],
      compute: (ctx) => ({
        total: ((ctx.values.qty as number) ?? 0) * ((ctx.values.unit_price as number) ?? 0),
      }),
    },
  },
};

/** A registry whose `invoice_reader` group grants READ on `invoice`; the
 * `order_reader` group exists but grants the WRONG entity (proves default-deny). */
function invoiceRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register(
    definePermissionGroup({
      name: "invoice_reader",
      label: "Invoice Reader",
      grant: { invoice: { data: { read: "all" } } },
    }),
  );
  registry.register(
    definePermissionGroup({
      name: "order_reader",
      label: "Order Reader",
      grant: { order: { data: { read: "all" } } },
    }),
  );
  return registry;
}

const READER: Actor = { type: "human", id: "invoice_reader_1", groups: ["invoice_reader"] };
const STRANGER: Actor = { type: "human", id: "order_reader_1", groups: ["order_reader"] };

/** Build the REAL server with the REAL cap-permission middleware + onchange route. */
function buildApp(actor: Actor): { handle: (req: Request) => Promise<Response> } {
  const entityRegistry = createEntityRegistry();
  entityRegistry.register(invoiceEntity);
  const store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });
  const commandLayer = createCommandLayer({ executor });
  commandLayer.use(createPermissionMiddlewareRegistration({ registry: invoiceRegistry() }));
  const evaluator = createOnchangeEvaluator({ entityRegistry, dataProvider: store });
  const graphqlSchema = buildGraphQLSchema([invoiceEntity]);
  return createServer(graphqlSchema, {
    executor,
    commandLayer,
    entityRegistry,
    onchangeEvaluator: evaluator,
    resolveRequestActor: () => actor,
  });
}

async function postOnchange(app: {
  handle: (req: Request) => Promise<Response>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(
    new Request(`${BASE}/api/entities/invoice/onchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changedField: "qty", values: { qty: 3, unit_price: 10 } }),
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("onchange authz spine — real route + real cap-permission (meta.onchange seam)", () => {
  test("reader WITH grant.invoice.data.read: authorized → computed onchange result", async () => {
    const { status, body } = await postOnchange(buildApp(READER));

    // Past the REAL permission slot (the entity read grant matched the documented
    // meta.onchange target) and the real evaluator ran: total = 3 * 10.
    expect(status).toBe(200);
    const updates = body.updates as Record<string, unknown> | undefined;
    expect(updates?.total).toBe(30);
  });

  test("stranger WITHOUT invoice read: denied → canonical AUTHZ_DENIED (403)", async () => {
    const { status, body } = await postOnchange(buildApp(STRANGER));

    // The REAL permission engine default-denies an actor with no read access to
    // `invoice` — the canonical, side-channel-free envelope, not an allow-all leak.
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    const error = body.error as { code?: string } | undefined;
    expect(error?.code).toBe("AUTHZ_DENIED");
  });
});
