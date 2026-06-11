/**
 * Dev-mode role switching — `x-dev-role` header → actor resolution.
 *
 * Two layers, both against the REAL implementation the dev wiring uses
 * (`src/dev-actor-resolver.ts` is imported by `dev.ts` AND defaulted by
 * `createDevApp`, so there is exactly one resolver to drift):
 *
 * 1. Unit: `resolveDevRoleActor(request)` maps recognized roles to their
 *    synthetic actors and falls back to the elevated `NO_AUTH_ACTOR` for
 *    absent/unrecognized values (back-compat with the historical no-resolver
 *    dev mode).
 *
 * 2. In-process HTTP: `createDevApp(...)` WITHOUT a caller-supplied resolver —
 *    i.e. the actual dev default — driven via `app.handle(new Request(...))`
 *    (port-free, never `app.listen`). A synthetic `reveal_actor` action echoes
 *    `ctx.actor` so the test observes exactly which actor the CommandLayer
 *    pipeline executed with, through both the REST action path and GraphQL.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { ActionDefinition, CapabilityDefinition, EntityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { DEV_ROLE_ACTORS, DEV_ROLE_HEADER, resolveDevRoleActor } from "../src/dev-actor-resolver";
import { createDevApp } from "../src/dev-app";
import { NO_AUTH_ACTOR } from "../src/routes/shared";

// ── Unit: resolver function ────────────────────────────────

/** Build an in-process Request carrying an optional x-dev-role header. */
function req(role?: string): Request {
  const headers: Record<string, string> = {};
  if (role !== undefined) headers[DEV_ROLE_HEADER] = role;
  return new Request("http://local.test/api/actions/anything", { method: "POST", headers });
}

describe("resolveDevRoleActor (unit)", () => {
  it("maps x-dev-role: user to the restricted purchase_user actor", () => {
    const actor = resolveDevRoleActor(req("user"));
    expect(actor).toEqual({
      type: "human",
      id: "dev-user",
      name: "Dev User",
      groups: ["purchase_user", "user"],
    });
  });

  it("maps x-dev-role: manager to the purchase_manager actor", () => {
    const actor = resolveDevRoleActor(req("manager"));
    expect(actor).toEqual({
      type: "human",
      id: "dev-manager",
      name: "Dev Manager",
      groups: ["purchase_manager", "manager", "user"],
    });
  });

  it("maps x-dev-role: admin to the elevated dev-admin actor", () => {
    const actor = resolveDevRoleActor(req("admin"));
    expect(actor).toEqual({
      type: "human",
      id: "dev-admin",
      name: "Dev Admin",
      groups: ["admin", "manager", "user"],
    });
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(resolveDevRoleActor(req(" Manager "))).toBe(DEV_ROLE_ACTORS.manager);
    expect(resolveDevRoleActor(req("USER"))).toBe(DEV_ROLE_ACTORS.user);
  });

  it("falls back to the elevated NO_AUTH_ACTOR when the header is absent (back-compat)", () => {
    expect(resolveDevRoleActor(req())).toBe(NO_AUTH_ACTOR);
  });

  it("falls back to the elevated NO_AUTH_ACTOR for unrecognized values (back-compat)", () => {
    for (const value of ["superadmin", "", "  ", "manager;admin"]) {
      expect(resolveDevRoleActor(req(value))).toBe(NO_AUTH_ACTOR);
    }
  });

  it("never returns undefined — the ANONYMOUS downgrade fallback cannot trigger", () => {
    expect(resolveDevRoleActor(req("garbage"))).toBeDefined();
    expect(resolveDevRoleActor(req())).toBeDefined();
  });
});

// ── In-process HTTP: dev wiring default ───────────────────

/** Minimal entity so the capability assembles a non-empty GraphQL schema. */
const probeEntity: EntityDefinition = {
  name: "probe",
  label: "Probe",
  description: "Synthetic entity for dev-role resolver e2e",
  fields: {
    note: { type: "string", label: "Note" },
  },
};

/**
 * Echoes the actor the CommandLayer pipeline resolved for this execution —
 * the observable seam for "which role did this request run as?".
 */
const revealActorAction: ActionDefinition = {
  name: "reveal_actor",
  entity: "probe",
  label: "Reveal Actor",
  description: "Echo the executing actor (dev-role resolver test probe)",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => ({ actor: ctx.actor }),
};

const capProbe: CapabilityDefinition = defineCapability({
  name: "cap-dev-role-probe",
  label: "Dev Role Probe",
  description: "Synthetic capability exposing an actor-echo action",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [probeEntity],
  actions: [revealActorAction],
});

// In-process, port-free: the URL only supplies a path to `new Request(...)`
// for `app.handle` — no socket is bound (NEVER app.listen in tests).
const REST_URL = "http://local.test/api/actions/reveal_actor";
const GQL_URL = "http://local.test/graphql";

let app: ReturnType<typeof createDevApp>["app"];

beforeAll(() => {
  // No resolveRequestActor passed — this exercises the createDevApp DEFAULT,
  // which is the same `resolveDevRoleActor` that dev.ts wires for
  // `bun run dev:server`.
  app = createDevApp([capProbe], { cors: false }).app;
});

interface EchoedActor {
  type: string;
  id: string;
  name?: string;
  groups: string[];
}

async function revealViaRest(role?: string): Promise<EchoedActor> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (role !== undefined) headers[DEV_ROLE_HEADER] = role;
  const res = await app.handle(new Request(REST_URL, { method: "POST", headers, body: "{}" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: { actor: EchoedActor } };
  expect(body.success).toBe(true);
  return body.data.actor;
}

describe("x-dev-role over in-process HTTP (createDevApp default wiring)", () => {
  it("REST: x-dev-role: user executes as the purchase_user actor", async () => {
    const actor = await revealViaRest("user");
    expect(actor.id).toBe("dev-user");
    expect(actor.type).toBe("human");
    expect(actor.groups).toEqual(["purchase_user", "user"]);
  });

  it("REST: x-dev-role: manager executes as the purchase_manager actor", async () => {
    const actor = await revealViaRest("manager");
    expect(actor.id).toBe("dev-manager");
    expect(actor.groups).toEqual(["purchase_manager", "manager", "user"]);
  });

  it("REST: x-dev-role: admin executes as the elevated dev-admin actor", async () => {
    const actor = await revealViaRest("admin");
    expect(actor.id).toBe("dev-admin");
    expect(actor.groups).toEqual(["admin", "manager", "user"]);
  });

  it("REST: no header keeps today's elevated no-auth default (back-compat)", async () => {
    const actor = await revealViaRest();
    expect(actor.id).toBe("anonymous");
    expect(actor.groups).toEqual(["admin", "manager", "user"]);
  });

  it("REST: unrecognized role keeps today's elevated no-auth default (back-compat)", async () => {
    const actor = await revealViaRest("root");
    expect(actor.id).toBe("anonymous");
    expect(actor.groups).toEqual(["admin", "manager", "user"]);
  });

  it("GraphQL: the same header drives the action-mutation channel", async () => {
    // The generic executeAction mutation returns JSON-encoded result data,
    // which lets the probe action's echoed actor cross the GraphQL boundary.
    const res = await app.handle(
      new Request(GQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", [DEV_ROLE_HEADER]: "manager" },
        body: JSON.stringify({
          query: `mutation { executeAction(name: "reveal_actor", input: "{}") { success data } }`,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { executeAction?: { success: boolean; data: string | null } };
      errors?: Array<{ message: string }>;
    };
    expect(body.errors).toBeUndefined();
    expect(body.data?.executeAction?.success).toBe(true);
    const payload = JSON.parse(body.data?.executeAction?.data ?? "{}") as { actor?: EchoedActor };
    expect(payload.actor?.id).toBe("dev-manager");
    expect(payload.actor?.groups).toEqual(["purchase_manager", "manager", "user"]);
  });
});
