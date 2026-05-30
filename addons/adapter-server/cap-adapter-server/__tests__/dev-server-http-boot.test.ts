/**
 * Dev-server HTTP boot smoke test.
 *
 * The schema-level boot smoke (`dev-schema-boot.test.ts`) proves the GraphQL
 * schema ASSEMBLES and is EXECUTABLE via `graphqlSync`. This test covers the
 * NEXT layer: it boots the actual Elysia HTTP app the dev server serves and
 * dispatches real requests over HTTP semantics.
 *
 * It runs entirely in-process — `await app.handle(new Request(...))` — so it is:
 *   - port-free: no `listen()`, no socket bound, no `fetch` over the network;
 *   - DB-free: no `DATABASE_TEST_URL`, no `dataProvider` supplied, so
 *     `assembleDevSchema` (via `createDevApp`) falls back to `InMemoryStore`.
 *
 * Why this matters: `dev.ts` inlines the bridge that hands the assembled runtime
 * to `createServer(...)`. An HTTP wiring regression there (a route module
 * crashing on the in-memory runtime, `createServer` mis-wiring
 * `entityRegistry`/`dataProvider`, the yoga handler not mounting) would only
 * surface at `bun run dev:server`. `createDevApp` is the shared bridge both this
 * test and the real dev server use, so such a regression now fails CI instead.
 *
 * The capability set mirrors `dev-schema-boot.test.ts`: the adapter itself
 * (`cap-adapter-server`), a published system capability that contributes a
 * `graphqlExtensions` graphql type instance (`cap-chatter`), and an inline
 * synthetic business capability contributing entities + a custom action + a
 * relation + a state machine. The synthetic cap is defined inline (rather than
 * importing from the schema-boot test or a private demo) so this PUBLISHED
 * package keeps a clean dependency surface.
 */

import { describe, expect, it } from "bun:test";
import { capChatter } from "@linchkit/cap-chatter";
import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  RelationDefinition,
  StateDefinition,
} from "@linchkit/core";
import { defineCapability, defineRelation } from "@linchkit/core";
import { capAdapterServer } from "../src/capability";
import { createDevApp } from "../src/dev-app";

// ── Synthetic business capability ─────────────────────────────────────────
//
// Stands in for the (private, unpublished) purchase demo. Contributes two
// entities (one a relation target), a custom action, a relation, and a state
// machine — exercising the full entity/action/relation/state assembly path.

const projectEntity: EntityDefinition = {
  name: "smoke_project",
  label: "Smoke Project",
  description: "Synthetic project entity for the dev-boot HTTP smoke test",
  presentation: {
    titleField: "name",
    badgeField: "status",
    summaryFields: ["owner"],
    icon: "folder",
  },
  fields: {
    name: { type: "string", required: true, label: "Name", ui: { importance: "primary" } },
    owner: { type: "string", label: "Owner", ui: { importance: "primary" } },
    status: {
      type: "state",
      machine: "smoke_project_lifecycle",
      default: "open",
      ui: { importance: "primary", display: "badge" },
    },
  },
};

const milestoneEntity: EntityDefinition = {
  name: "smoke_milestone",
  label: "Smoke Milestone",
  description: "Synthetic milestone entity — the relation target of a project",
  presentation: {
    titleField: "title",
    summaryFields: ["due_at"],
    icon: "flag",
  },
  fields: {
    title: { type: "string", required: true, label: "Title", ui: { importance: "primary" } },
    due_at: { type: "datetime", label: "Due At", ui: { importance: "detail" } },
  },
};

const archiveProjectAction: ActionDefinition = {
  name: "archive_smoke_project",
  entity: "smoke_project",
  label: "Archive Project",
  description: "Custom action that drives the project state machine to archived",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  stateTransition: { from: "open", to: "archived" },
};

const projectToMilestones: RelationDefinition = defineRelation({
  name: "smoke_project_to_milestones",
  from: "smoke_project",
  to: "smoke_milestone",
  cardinality: "one_to_many",
  fromName: "milestones",
  toName: "project",
  cascade: "delete",
  label: { from: "Milestones", to: "Project" },
});

const projectState: StateDefinition = {
  name: "smoke_project_lifecycle",
  entity: "smoke_project",
  field: "status",
  initial: "open",
  states: ["open", "archived"],
  transitions: [{ from: "open", to: "archived", action: "archive_smoke_project" }],
  meta: {
    open: { label: "Open", color: "green" },
    archived: { label: "Archived", color: "gray" },
  },
};

const capSmokeBusiness: CapabilityDefinition = defineCapability({
  name: "cap-smoke-business",
  label: "Smoke Business",
  description:
    "Synthetic business capability (inline) standing in for the unpublished demo — " +
    "contributes entities + a custom action + a relation + a state machine",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [projectEntity, milestoneEntity],
  actions: [archiveProjectAction],
  states: [projectState],
  relations: [projectToMilestones],
});

/**
 * Representative configured-capability set — mirrors `dev-schema-boot.test.ts`
 * and `config/capabilities.ts`: the adapter itself, a published system
 * capability carrying a `graphqlExtensions` graphql type instance, and a
 * synthetic business module.
 */
function configuredCapabilities(): CapabilityDefinition[] {
  return [capAdapterServer, capChatter, capSmokeBusiness];
}

/** Build the in-process dev app once per describe block (DB-free, port-free). */
function buildApp(): ReturnType<typeof createDevApp>["app"] {
  // CORS disabled so the in-process Request needs no Origin negotiation.
  return createDevApp(configuredCapabilities(), { cors: false }).app;
}

/** POST a GraphQL operation through `app.handle` (no port, no network). */
async function postGraphQL(
  app: ReturnType<typeof createDevApp>["app"],
  query: string,
  variables?: Record<string, unknown>,
): Promise<Response> {
  return app.handle(
    new Request("http://local.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
}

describe("dev-server HTTP boot (in-process, DB-free, port-free)", () => {
  it("serves a GraphQL introspection query over app.handle", async () => {
    const app = buildApp();
    const res = await postGraphQL(
      app,
      `{
        __schema {
          queryType { name }
          mutationType { name }
        }
      }`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors?: unknown[];
      data: { __schema: { queryType: { name: string }; mutationType: { name: string } } };
    };
    // GraphQL spec: a successful response has no top-level `errors`.
    expect(body.errors).toBeUndefined();
    expect(body.data.__schema.queryType.name).toBe("Query");
    expect(body.data.__schema.mutationType.name).toBe("Mutation");
  });

  it("serves a data list query that needs no seeded rows (empty typed result)", async () => {
    const app = buildApp();
    // `smoke_project` comes from the synthetic business capability. With the
    // InMemoryStore empty (no seed, no DB), the list resolver returns a
    // well-formed, typed-but-empty page — proving the resolver chain runs
    // end-to-end over HTTP without a database.
    const res = await postGraphQL(
      app,
      `{
        smokeProjectList {
          items { id name status }
          total
          pageInfo { limit offset hasMore }
        }
      }`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors?: unknown[];
      data: {
        smokeProjectList: {
          items: unknown[];
          total: number;
          pageInfo: { limit: number; offset: number; hasMore: boolean };
        };
      };
    };
    expect(body.errors).toBeUndefined();
    const list = body.data.smokeProjectList;
    expect(Array.isArray(list.items)).toBe(true);
    expect(list.items).toHaveLength(0);
    expect(list.total).toBe(0);
    expect(list.pageInfo.hasMore).toBe(false);
  });

  it("serves the entity-metadata REST endpoint over app.handle (DB-free)", async () => {
    const app = buildApp();
    // GET /api/entities lists entity metadata straight from the EntityRegistry —
    // no DB rows required. Proves a REST route module is mounted and reads the
    // runtime the dev-app factory wired in.
    const res = await app.handle(new Request("http://local.test/api/entities"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ name: string; label?: string }>;
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // The synthetic business entities surface in the metadata listing.
    const names = body.data.map((e) => e.name);
    expect(names).toContain("smoke_project");
    expect(names).toContain("smoke_milestone");
  });

  it("serves the GET /api/entities/:name detail endpoint (DB-free)", async () => {
    const app = buildApp();
    // The detail endpoint bundles schema + views + states + relations from the
    // registry/capabilities — still no DB rows. Confirms the richer metadata
    // route also boots against the in-memory runtime.
    const res = await app.handle(new Request("http://local.test/api/entities/smoke_project"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        name: string;
        states: Array<{ name: string }>;
        relations: Array<{ name: string }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("smoke_project");
    // State machine + relation contributed by the synthetic capability are bundled.
    expect(body.data.states.some((s) => s.name === "smoke_project_lifecycle")).toBe(true);
    expect(body.data.relations.some((r) => r.name === "smoke_project_to_milestones")).toBe(true);
  });
});
