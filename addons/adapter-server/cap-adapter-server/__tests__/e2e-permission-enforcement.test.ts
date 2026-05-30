/**
 * E2E Test: cap-permission RBAC enforcement through the CommandLayer permission slot
 *
 * Unlike `e2e-auth.test.ts` — which wires an *in-test* allowlist middleware
 * (`REQUIRED_GROUPS_BY_ACTION`) as a stand-in for the permission capability —
 * this test wires the REAL `cap-permission` capability via
 * `createCapPermission({ registry })`. That factory registers the production
 * `createPermissionMiddleware` (backed by core's `PermissionRegistry` +
 * `checkActionPermission` + `resolveDataAccess`) into the `permission` slot.
 *
 * The full stack runs through `createDevApp(...)` — real GraphQL schema, real
 * CommandLayer pipeline, real REST + GraphQL routes, InMemoryStore (DB-free) —
 * and is driven over a real HTTP listener with `fetch`, exactly like the other
 * e2e REST tests in this package. No mocks of the permission decision: every
 * denial originates from the real engine.
 *
 * Proves:
 *   (a) an actor WITHOUT the required permission is DENIED (HTTP 403, the real
 *       `authz.action.denied` shape) through both the REST action path and the
 *       GraphQL CRUD-mutation path;
 *   (b) an actor WITH the permission is ALLOWED and the side effect persists;
 *   (c) an actor whose group does not grant the action is denied even though it
 *       IS a registered, otherwise-capable group — proving the slot evaluates
 *       per-action grants rather than waving the actor through.
 *
 * Guard: when no capability registers a `permission` middleware, the dev
 * assembler injects a `dev:allow_all_permission` pass-through. By asserting
 * real denials below, this test also proves that stub is NOT in effect — the
 * permission slot is the real cap-permission middleware.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createCapPermission } from "@linchkit/cap-permission";
import type {
  ActionDefinition,
  Actor,
  CapabilityDefinition,
  EntityDefinition,
  PermissionGroupDefinition,
} from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { PermissionRegistry } from "@linchkit/core/server";
import { createDevApp } from "../src/dev-app";

// ── Test entity ────────────────────────────────────────────
//
// `report` carries an observable `archived` flag so a successful `archive_report`
// has a side effect we can read back, and a denied one can be shown to be absent.

const reportEntity: EntityDefinition = {
  name: "report",
  label: "Report",
  description: "Synthetic entity for permission-enforcement e2e",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    archived: { type: "boolean", label: "Archived", default: false },
  },
};

// ── Custom action ──────────────────────────────────────────
//
// `archive_report` flips `archived` to true via the data provider, so a 200
// response is backed by a real persisted mutation.

const archiveReportAction: ActionDefinition = {
  name: "archive_report",
  entity: "report",
  label: "Archive Report",
  description: "Archive a report — gated by the cap-permission permission slot",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const updated = await ctx.update("report", id, { archived: true });
    return { archived: true, report: updated };
  },
};

// ── Permission groups ──────────────────────────────────────
//
// The permission middleware resolves `capabilityName` from `action.entity`
// (no custom `resolveCapability`), so lookups are keyed as
// `permissions[<entity>][<entity>]` — here `permissions.report.report`.
//
// Engine merge rule: default-deny. An action is allowed only if some group of
// the actor explicitly sets `actions[<name>] = true` (and none set `false`).

/** May create reports, but NOT archive them — proves per-action gating. */
const reportViewerGroup: PermissionGroupDefinition = {
  name: "report_viewer",
  label: "Report Viewer",
  permissions: {
    report: {
      report: {
        actions: { create_report: true },
        data: { read: "all", write: "all" },
      },
    },
  },
};

/** Full access: may create AND archive reports. */
const reportManagerGroup: PermissionGroupDefinition = {
  name: "report_manager",
  label: "Report Manager",
  permissions: {
    report: {
      report: {
        actions: { create_report: true, archive_report: true },
        data: { read: "all", write: "all" },
      },
    },
  },
};

// ── Capability assembly ────────────────────────────────────

/** Carries the test entity + custom action so the assembler registers them. */
const capReportTest: CapabilityDefinition = defineCapability({
  name: "cap-report-test",
  label: "Report Test",
  description: "Synthetic capability contributing the report entity + archive action",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [reportEntity],
  actions: [archiveReportAction],
});

/** Build a fresh PermissionRegistry seeded with the test groups. */
function buildRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();
  registry.register(reportViewerGroup);
  registry.register(reportManagerGroup);
  return registry;
}

// ── Actor wiring ───────────────────────────────────────────
//
// The auth slot's only job here is to set `ctx.actor`; we simulate that with a
// token→actor resolver so the test stays focused on the permission slot.

const TOKENS: Record<string, Actor> = {
  "Bearer viewer": { type: "human", id: "viewer-1", groups: ["report_viewer"] },
  "Bearer manager": { type: "human", id: "manager-1", groups: ["report_manager"] },
  // Actor whose group is NOT registered in the registry → engine default-deny.
  "Bearer stranger": { type: "human", id: "stranger-1", groups: ["unregistered_group"] },
};

function resolveRequestActor(request: Request): Actor | undefined {
  const auth = request.headers.get("authorization");
  if (!auth) return undefined; // → ANONYMOUS_ACTOR (human, no groups)
  return TOKENS[auth];
}

// ── App + helpers ──────────────────────────────────────────

// Bind an OS-assigned free port (listen(0)) rather than a hardcoded one so
// parallel test runs — or an already-bound port — don't cause flaky
// collisions. REST_BASE / GQL_URL are resolved from the actual port in
// beforeAll, before any test runs.
let REST_BASE: string;
let GQL_URL: string;

let app: ReturnType<typeof createDevApp>["app"];

beforeAll(() => {
  // Assemble the app ONCE and bind the port once (re-listening on the same
  // port between tests can crash the Bun runtime). The REAL cap-permission
  // middleware occupies the `permission` slot, so the dev allow-all stub is
  // NOT injected. CORS disabled — same-origin in-test fetch. Tests reference
  // records by the id returned at creation, so the shared InMemoryStore needs
  // no per-test reset.
  const capPermission = createCapPermission({ registry: buildRegistry() });
  app = createDevApp([capReportTest, capPermission], {
    cors: false,
    resolveRequestActor,
  }).app;
  app.listen(0);
  const port = app.server?.port ?? 0;
  REST_BASE = `http://localhost:${port}/api/actions`;
  GQL_URL = `http://localhost:${port}/graphql`;
});

afterAll(() => {
  app?.stop();
});

interface RestResult {
  status: number;
  body: {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string; details?: unknown };
  };
}

async function restAction(
  name: string,
  input: Record<string, unknown> = {},
  auth?: string,
): Promise<RestResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await fetch(`${REST_BASE}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as RestResult["body"] };
}

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

async function gql(query: string, auth?: string): Promise<GqlResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as GqlResult;
}

/** Create a report as the manager (allowed) and return its id. */
async function seedReportAsManager(title: string): Promise<string> {
  const created = await restAction("create_report", { title }, "Bearer manager");
  expect(created.status).toBe(200);
  expect(created.body.success).toBe(true);
  const data = created.body.data as { id: string };
  expect(data.id).toBeDefined();
  return data.id;
}

// ── Tests ──────────────────────────────────────────────────

describe("E2E cap-permission enforcement (real permission slot, in-process HTTP)", () => {
  describe("REST action path", () => {
    it("(a) DENIES a viewer archiving a report — real authz.action.denied → 403", async () => {
      const id = await seedReportAsManager("Quarterly Report");

      const result = await restAction("archive_report", { id }, "Bearer viewer");

      // The denial comes from createPermissionMiddleware throwing
      // AuthorizationError({ code: "authz.action.denied" }), which the
      // CommandLayer surfaces as { success:false, data:{ code, error } } and
      // the REST route maps `authz.action.denied` → HTTP 403.
      expect(result.status).toBe(403);
      expect(result.body.success).toBe(false);
      expect(result.body.error?.code).toBe("ACTION.EXECUTION.FAILED");
      expect(result.body.error?.message).toContain("Permission denied");
      expect(result.body.error?.message).toContain("archive_report");
      // The denial reason is the engine's real default-deny verdict.
      expect(result.body.error?.message).toContain("No permission group grants this action");
      // The capability the slot evaluated against is surfaced in details.
      expect(result.body.error?.details).toMatchObject({
        action: "archive_report",
        capability: "report",
      });

      // Side effect must NOT have happened: the report is still un-archived.
      // (The boolean `default` is not materialized on create, so the field is
      // null until something writes it — the point is it is NOT `true`.)
      const after = await gql(`query { report(id: "${id}") { id archived } }`, "Bearer manager");
      const report = after.data?.report as { archived: boolean | null };
      expect(report.archived).not.toBe(true);
    });

    it("(b) ALLOWS a manager archiving a report — 200 + persisted side effect", async () => {
      const id = await seedReportAsManager("Annual Report");

      const result = await restAction("archive_report", { id }, "Bearer manager");

      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      const data = result.body.data as { archived: boolean };
      expect(data.archived).toBe(true);

      // Side effect persisted — read back through GraphQL.
      const after = await gql(`query { report(id: "${id}") { id archived } }`, "Bearer manager");
      const report = after.data?.report as { archived: boolean };
      expect(report.archived).toBe(true);
    });

    it("DENIES an actor whose groups are not in the registry — default-deny → 403", async () => {
      const id = await seedReportAsManager("Stranger Report");

      const result = await restAction("archive_report", { id }, "Bearer stranger");

      expect(result.status).toBe(403);
      expect(result.body.success).toBe(false);
      expect(result.body.error?.code).toBe("ACTION.EXECUTION.FAILED");
      expect(result.body.error?.message).toContain("Permission denied");
    });

    it("DENIES an anonymous (no-token) actor — no groups → 403", async () => {
      const id = await seedReportAsManager("Anon Report");

      const result = await restAction("archive_report", { id });

      expect(result.status).toBe(403);
      expect(result.body.success).toBe(false);
      expect(result.body.error?.message).toContain("Permission denied");
    });

    it("(c) ALLOWS the same viewer to create — isolates archive denial as a per-action decision", async () => {
      // The viewer group DOES grant create_report, so create succeeds. This
      // proves the archive denial above is a genuine per-action permission
      // verdict, not a blanket "viewer can do nothing".
      const result = await restAction(
        "create_report",
        { title: "Viewer Created" },
        "Bearer viewer",
      );
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
    });
  });

  describe("GraphQL CRUD-mutation path", () => {
    it("DENIES a stranger's createReport mutation through the same permission slot", async () => {
      const result = await gql(
        `mutation { createReport(input: { title: "GQL Denied" }) { id title } }`,
        "Bearer stranger",
      );

      // The CRUD mutation resolver rethrows the CommandLayer failure; graphql-yoga
      // masks the non-GraphQLError throw to a generic message, but the operation
      // is unambiguously denied: a top-level error is present and the field
      // resolves to null. (The REST tests above assert the real message text.)
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.data?.createReport ?? null).toBeNull();
    });

    it("ALLOWS a manager's createReport mutation", async () => {
      const result = await gql(
        `mutation { createReport(input: { title: "GQL Allowed" }) { id title } }`,
        "Bearer manager",
      );

      expect(result.errors).toBeUndefined();
      const created = result.data?.createReport as { id: string; title: string };
      expect(created.title).toBe("GQL Allowed");
      expect(created.id).toBeDefined();
    });
  });
});
