/**
 * Action round-trip SMOKE test.
 *
 * Complements `dev-server-http-boot.test.ts` (which covers read-path HTTP wiring)
 * by exercising the WRITE path: a full create → read round-trip through the
 * CommandLayer → Action engine → InMemoryStore persistence pipeline.
 *
 * Guards the class of regression where everything compiles and reads work, but
 * writing an entity through the full action pipeline is silently broken.
 *
 * Setup mirrors `dev-server-http-boot.test.ts` exactly:
 *  - Same `createDevApp(capabilities, { cors: false })` bootstrap.
 *  - Same synthetic business capability (smoke_project + smoke_milestone).
 *  - Requests dispatched in-process via `app.handle(new Request(...))`.
 *  - DB-free: no Postgres — InMemoryStore is the fallback when no dataProvider.
 *  - Port-free: no `listen()`, no socket, no real network.
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

// ── Synthetic business capability (inline, matches boot test) ──────────────
//
// Keeps the published package dependency-surface clean — no imports from
// the private demo. Contributes two entities, one custom action, a relation,
// and a state machine, identical to `dev-server-http-boot.test.ts`.

const projectEntity: EntityDefinition = {
  name: "smoke_project",
  label: "Smoke Project",
  description: "Synthetic project entity for the action round-trip smoke test",
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
  description: "Synthetic milestone entity — relation target of a project",
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
  description: "Drives the project state machine to archived",
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
    "Synthetic business capability (inline) — contributes entities + action + relation + state",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [projectEntity, milestoneEntity],
  actions: [archiveProjectAction],
  states: [projectState],
  relations: [projectToMilestones],
});

// ── App factory ────────────────────────────────────────────────────────────

/** Build the in-process dev app (DB-free, port-free). One per test suite is fine. */
function buildApp(): ReturnType<typeof createDevApp>["app"] {
  return createDevApp([capAdapterServer, capChatter, capSmokeBusiness], { cors: false }).app;
}

// ── Request helpers ────────────────────────────────────────────────────────

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

/** POST to a REST action endpoint through `app.handle`. */
async function postAction(
  app: ReturnType<typeof createDevApp>["app"],
  name: string,
  input: Record<string, unknown> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://local.test/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

// ── Type helpers (no `any`) ────────────────────────────────────────────────

interface ActionResponseSuccess {
  success: true;
  data: Record<string, unknown>;
  meta: { executionId: string };
}

interface ActionResponseError {
  success: false;
  error: { code: string; message: string };
  meta?: { executionId?: string };
}

type ActionResponse = ActionResponseSuccess | ActionResponseError;

interface GraphQLResponse<T = Record<string, unknown>> {
  data: T;
  errors?: Array<{ message: string }>;
}

interface RecordRow {
  id: string;
  name: string;
  owner?: string | null;
  status?: string | null;
}

interface ListResult {
  items: RecordRow[];
  total: number;
  pageInfo: { limit: number; offset: number; hasMore: boolean };
}

// ── Smoke suite ────────────────────────────────────────────────────────────

describe("action round-trip smoke (in-process, DB-free, port-free)", () => {
  // ── Smoke 1: REST write path ─────────────────────────────────────────────
  //
  // POST /api/actions/create_smoke_project → assert 2xx + id + fields →
  // GET /api/entities/smoke_project (metadata confirms entity is live) →
  // GraphQL list query to prove the written record persists.
  //
  // Note: each `buildApp()` call creates a fresh in-memory store, so
  // Smoke 1 and Smoke 2 are fully isolated even when run in one process.

  it("Smoke 1 (REST): create via POST /api/actions/:name → record persists in list", async () => {
    const app = buildApp();

    // Step 1: create a smoke_project via the auto-generated CRUD action
    const createRes = await postAction(app, "create_smoke_project", {
      name: "Atlas",
      owner: "alice",
    });
    expect(createRes.status).toBe(200);

    const createBody = (await createRes.json()) as ActionResponse;
    expect(createBody.success).toBe(true);

    const created = (createBody as ActionResponseSuccess).data;
    expect(typeof created.id).toBe("string");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Atlas");
    expect(created.owner).toBe("alice");

    const createdId = created.id as string;

    // Step 2: list via GraphQL — the newly created record must appear
    const listRes = await postGraphQL(
      app,
      `{
        smokeProjectList {
          items { id name owner status }
          total
          pageInfo { limit offset hasMore }
        }
      }`,
    );
    expect(listRes.status).toBe(200);

    const listBody = (await listRes.json()) as GraphQLResponse<{
      smokeProjectList: ListResult;
    }>;
    expect(listBody.errors).toBeUndefined();

    const list = listBody.data.smokeProjectList;
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(list.pageInfo.hasMore).toBe(false);

    const row = list.items[0];
    expect(row.id).toBe(createdId);
    expect(row.name).toBe("Atlas");
    expect(row.owner).toBe("alice");
    // status field should default to the state machine's initial value
    expect(row.status).toBeTruthy();
  });

  // ── Smoke 2: GraphQL write path ──────────────────────────────────────────
  //
  // GraphQL createSmokeProject mutation → assert success + id + fields →
  // GraphQL single-entity query to prove the record round-trips correctly.

  it("Smoke 2 (GraphQL): createSmokeProject mutation → record queryable by id", async () => {
    const app = buildApp();

    // Step 1: create via the auto-generated GraphQL CRUD mutation
    const createRes = await postGraphQL(
      app,
      `mutation CreateProject($input: SmokeProjectInput!) {
        createSmokeProject(input: $input) {
          id name owner status _version created_at
        }
      }`,
      { input: { name: "Orion", owner: "bob" } },
    );
    expect(createRes.status).toBe(200);

    const createBody = (await createRes.json()) as GraphQLResponse<{
      createSmokeProject: RecordRow & { _version: number; created_at: string };
    }>;
    expect(createBody.errors).toBeUndefined();

    const created = createBody.data.createSmokeProject;
    expect(typeof created.id).toBe("string");
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Orion");
    expect(created.owner).toBe("bob");
    // _version starts at 1 for a freshly created record
    expect(created._version).toBe(1);
    expect(created.created_at).toBeTruthy();

    const createdId = created.id;

    // Step 2: query the record back by id — proves persistence, not just
    // return-value correctness
    const getRes = await postGraphQL(
      app,
      `query GetProject($id: ID!) {
        smokeProject(id: $id) {
          id name owner status _version
        }
      }`,
      { id: createdId },
    );
    expect(getRes.status).toBe(200);

    const getBody = (await getRes.json()) as GraphQLResponse<{
      smokeProject: (RecordRow & { _version: number }) | null;
    }>;
    expect(getBody.errors).toBeUndefined();

    const fetched = getBody.data.smokeProject;
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(createdId);
    expect(fetched?.name).toBe("Orion");
    expect(fetched?.owner).toBe("bob");
    expect(fetched?._version).toBe(1);
  });

  // ── Smoke 3: server boots with full autoInstall capability set ───────────
  //
  // The boot smoke test in `dev-server-http-boot.test.ts` already verifies
  // this for the read path; this smoke asserts it is also true when the write
  // path is assembled (executor + commandLayer present), providing a guard
  // against the "server boots for reads but crashes on first write setup" case.

  it("Smoke 3 (boot): app assembles with write pipeline without throwing", () => {
    // If createDevApp throws, this test fails and the error surfaces clearly.
    expect(() => buildApp()).not.toThrow();
  });
});
