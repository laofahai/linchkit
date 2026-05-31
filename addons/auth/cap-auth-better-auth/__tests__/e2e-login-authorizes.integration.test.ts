/**
 * E2E integration: real login → real session token → authorized request
 * through the REAL CommandLayer `auth` slot.
 *
 * This closes a genuine coverage gap. The existing tests all mock one side of
 * the auth seam:
 * - cap-adapter-server/__tests__/e2e-auth.test.ts uses a fake `resolveRequestActor`
 *   that string-matches hardcoded tokens ("Bearer valid-user-token"); it never
 *   performs a real login nor runs the real cap-auth middleware.
 * - cap-auth/__tests__/middleware.test.ts drives `createAuthMiddleware` with mock
 *   resolver functions.
 * - cap-auth-better-auth/__tests__/provider.test.ts uses a mock DB and only asserts
 *   that *invalid* tokens resolve to null — it never logs a user in.
 *
 * Here every component is real and wired exactly as production wires it:
 *   BetterAuthProvider (real better-auth + Drizzle on Postgres)
 *     → createCapAuth({ provider })            (the real factory)
 *       → its contributed `auth` middleware     (createAuthMiddleware)
 *         → createCommandLayer `auth` slot       (the real pipeline)
 *
 * Flow under test:
 *   1. A real user registers + logs in → a real better-auth session token.
 *   2. A request carrying that token (Authorization: Bearer <token>) passes the
 *      auth slot and the resolved Actor (real user id) reaches the action handler.
 *   3. A request with a bogus token is rejected by the auth slot.
 *   4. A request with no credentials is rejected (allowAnonymous: false).
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 * Skips gracefully (describe.skipIf) when no database is reachable — these
 * DB-gated suites run in CI via the postgres service.
 *
 * better-auth manages its own user/session/account/verification tables. The
 * CREATE TABLE DDL is DERIVED from better-auth's own schema model
 * (`getAuthTables`), never hand-authored, so it stays correct as plugin fields
 * change. This is a test fixture, not production DDL (which drizzle-kit owns).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCapAuth } from "@linchkit/cap-auth";
import type { ActionContext, ActionDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { username } from "better-auth/plugins/username";
import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createBetterAuthProvider } from "../src/provider";

// ── Test configuration ───────────────────────────────────────

// When DATABASE_TEST_URL is explicitly set, the operator intends the suite to
// run against THAT database — an unreachable one is a CI/config failure, not a
// reason to silently skip (which would produce a false green). When it is unset
// (local dev), we fall back to the conventional local Postgres and skip cleanly
// if it happens to be down.
const DATABASE_TEST_URL_SET = process.env.DATABASE_TEST_URL !== undefined;
const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

// All test credentials are env-overridable and otherwise RUNTIME-GENERATED, so
// nothing secret-shaped is committed to source and the suite stays hermetic.
// Computed once at module scope so signup and login share identical values
// within a single run. Uses the global Web Crypto API (Bun provides it) — no
// `node:crypto` require.
//
// secret: must be >= 32 chars to satisfy better-auth (two hex UUIDs = 64 chars).
const TEST_SECRET =
  process.env.E2E_TEST_SECRET ??
  crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const TEST_BASE_URL = "http://localhost:3001";

// email: unique-per-run so reruns against the shared DB never collide.
const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? `e2e-${crypto.randomUUID()}@example.com`;
// password: a UUID comfortably exceeds better-auth's length >= 8 requirement.
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? crypto.randomUUID();

// ── better-auth option shape ─────────────────────────────────

/**
 * The plugin set MUST match what `createBetterAuthProvider` enables internally
 * (bearer + admin + username + phoneNumber), otherwise the derived schema would
 * miss plugin columns and the runtime adapter would reject the table.
 */
const authOptionsForSchema = {
  secret: TEST_SECRET,
  baseURL: TEST_BASE_URL,
  emailAndPassword: { enabled: true },
  plugins: [bearer(), admin(), username(), phoneNumber({ sendOTP: async () => {} })],
} satisfies BetterAuthOptions;

// ── Connection check ─────────────────────────────────────────

let client: ReturnType<typeof postgres> | null = null;
let db: PostgresJsDatabase | null = null;

/** Try to connect to the database. Returns true on success. */
async function canConnect(): Promise<boolean> {
  try {
    const probe = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
    try {
      await probe`SELECT 1`;
      return true;
    } finally {
      await probe.end();
    }
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  if (DATABASE_TEST_URL_SET) {
    // Fail loudly: a configured-but-unreachable DB must never silently skip.
    throw new Error(
      "DATABASE_TEST_URL is set but PostgreSQL is unreachable — refusing to silently skip",
    );
  }
  console.warn(
    "PostgreSQL not available, skipping cap-auth-better-auth e2e login integration test",
  );
}

// ── DDL helpers (derived from better-auth's own schema model) ─

// better-auth's tables in FK-safe DROP order (children before `user`). This
// test is the SOLE consumer of these tables — other DB-gated suites use their
// own tables — so a per-run drop/recreate (beforeAll) plus an afterAll drop is
// sufficient isolation in the shared CI Postgres, without a separate schema.
const BETTER_AUTH_TABLES = ["session", "account", "verification", "user"] as const;

/** Best-effort DROP of every better-auth table; ignores errors. */
async function dropBetterAuthTables(database: PostgresJsDatabase): Promise<void> {
  for (const t of BETTER_AUTH_TABLES) {
    try {
      await database.execute(sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`));
    } catch {
      // Best-effort cleanup — ignore so teardown never masks a test failure.
    }
  }
}

function pgColumnType(type: string): string {
  switch (type) {
    case "boolean":
      return "boolean";
    case "number":
      return "integer";
    case "date":
      return "timestamp";
    default:
      return "text";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: drizzle column builders share no common type
function drizzleColumn(name: string, type: string): any {
  switch (type) {
    case "boolean":
      return boolean(name);
    case "number":
      return integer(name);
    case "date":
      return timestamp(name);
    default:
      return text(name);
  }
}

// better-auth field model entry (subset we read).
interface AuthFieldModel {
  type: string;
  required?: boolean;
  unique?: boolean;
  fieldName?: string;
}
interface AuthTableModel {
  modelName: string;
  fields: Record<string, AuthFieldModel>;
}

/**
 * Create better-auth's tables from its own schema model and return a Drizzle
 * schema object the provider can hand to better-auth's drizzleAdapter.
 *
 * `user` is created first because `session`/`account` reference it; we keep the
 * FK columns as plain columns (no FK constraint needed for this auth test).
 */
async function setupBetterAuthTables(
  database: PostgresJsDatabase,
): Promise<Record<string, unknown>> {
  const tables = getAuthTables(authOptionsForSchema) as Record<string, AuthTableModel>;

  // Drop in FK-safe order for a clean slate before recreating.
  await dropBetterAuthTables(database);

  const drizzleSchema: Record<string, unknown> = {};
  // Create in dependency order (user before tables that reference it).
  for (const modelKey of ["user", "account", "verification", "session"]) {
    const model = tables[modelKey];
    if (!model) continue;

    const sqlColumns: string[] = ['"id" text PRIMARY KEY NOT NULL'];
    // biome-ignore lint/suspicious/noExplicitAny: column builders are heterogeneous
    const drizzleColumns: Record<string, any> = { id: text("id").primaryKey() };

    for (const [logicalName, field] of Object.entries(model.fields)) {
      const columnName = field.fieldName ?? logicalName;
      const notNull = field.required ? " NOT NULL" : "";
      const unique = field.unique ? " UNIQUE" : "";
      sqlColumns.push(`"${columnName}" ${pgColumnType(field.type)}${notNull}${unique}`);

      let column = drizzleColumn(columnName, field.type);
      if (field.required) column = column.notNull();
      if (field.unique) column = column.unique();
      drizzleColumns[logicalName] = column;
    }

    await database.execute(sql.raw(`CREATE TABLE "${model.modelName}" (${sqlColumns.join(", ")})`));
    drizzleSchema[model.modelName] = pgTable(model.modelName, drizzleColumns);
  }

  return drizzleSchema;
}

// ── System actor used only to drive register/login actions ───

const SYSTEM_CTX = {
  actor: { type: "system" as const, id: "anonymous", groups: [] },
} as unknown as ActionContext;

// ── A read-only action that echoes the pipeline-resolved Actor ─

/**
 * Echoes `ctx.actor` so we can assert WHICH identity the real auth slot
 * resolved and handed to the executor. If auth resolution were skipped or
 * faked, this would return the anonymous actor (or never run at all).
 */
const whoamiAction: ActionDefinition = {
  name: "whoami",
  entity: "system",
  label: "Who Am I",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => ({
    actorId: ctx.actor.id,
    actorType: ctx.actor.type,
    groups: ctx.actor.groups,
  }),
};

// ── Suite ─────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)("cap-auth-better-auth e2e: login authorizes via CommandLayer", () => {
  let commandLayer: ReturnType<typeof createCommandLayer>;
  let validToken: string;

  beforeAll(async () => {
    client = postgres(DATABASE_URL, { max: 1 });
    db = drizzle(client);

    const drizzleSchema = await setupBetterAuthTables(db);

    // Real provider, real factory — exactly the production wiring path.
    const provider = createBetterAuthProvider({
      database: db,
      secret: TEST_SECRET,
      baseURL: TEST_BASE_URL,
      schema: drizzleSchema,
    });
    const capAuth = createCapAuth({
      provider,
      // allowAnonymous: false → an unauthenticated request must be rejected by
      // the auth slot (not silently allowed through as anonymous).
      config: { allowAnonymous: false },
    });

    const authMiddleware = capAuth.extensions?.middlewares?.find((m) => m.slot === "auth");
    if (!authMiddleware) {
      throw new Error("cap-auth did not contribute an auth-slot middleware");
    }

    // Real executor + CommandLayer with the real cap-auth middleware in the auth slot.
    const executor = createActionExecutor({
      dataProvider: new InMemoryStore(),
      executionLogger: new InMemoryExecutionLogger(),
    });
    executor.registry.register(whoamiAction);

    commandLayer = createCommandLayer({ executor });
    commandLayer.use({ name: "cap-auth", slot: "auth", handler: authMiddleware.handler });
    // A permissive permission middleware so the fail-closed guard is satisfied
    // and the test isolates AUTH behavior (not authorization rules).
    commandLayer.use({
      name: "allow-all-permission",
      slot: "permission",
      handler: async (_ctx, next) => {
        await next();
      },
    });

    // Real registration then real login → a real better-auth session token.
    await provider.register(SYSTEM_CTX, {
      name: "E2E Auth User",
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const loginResult = await provider.login(SYSTEM_CTX, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    validToken = loginResult.access_token;
    expect(validToken).toBeString();
    expect(validToken.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // Leave no residue in the shared test DB: drop the better-auth tables this
    // suite created (best-effort) before releasing the connection.
    if (db) await dropBetterAuthTables(db);
    if (client) await client.end();
  });

  test("a real session token authorizes the request and resolves the real Actor", async () => {
    const result = await commandLayer.execute({
      command: "whoami",
      input: {},
      channel: "http",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(result.success).toBe(true);
    const data = result.data as { actorId: string; actorType: string; groups: string[] };
    // The auth slot resolved a concrete human user, not the anonymous actor.
    expect(data.actorType).toBe("human");
    expect(data.actorId).toBeString();
    expect(data.actorId.length).toBeGreaterThan(0);
    expect(data.actorId).not.toBe("anonymous");
  });

  test("a bogus Bearer token is rejected by the real auth slot", async () => {
    const result = await commandLayer.execute({
      command: "whoami",
      input: {},
      channel: "http",
      headers: { authorization: "Bearer not-a-real-session-token" },
    });

    expect(result.success).toBe(false);
    const data = result.data as { error?: string; code?: string };
    expect(data.code).toBe("auth.token.invalid");
  });

  test("a request with no credentials is rejected (allowAnonymous: false)", async () => {
    const result = await commandLayer.execute({
      command: "whoami",
      input: {},
      channel: "http",
      headers: {},
    });

    expect(result.success).toBe(false);
    const data = result.data as { error?: string; code?: string };
    expect(data.code).toBe("auth.credentials.required");
  });

  test("the same token resolved twice is stable (real session persists)", async () => {
    const first = await commandLayer.execute({
      command: "whoami",
      input: {},
      channel: "http",
      headers: { authorization: `Bearer ${validToken}` },
    });
    const second = await commandLayer.execute({
      command: "whoami",
      input: {},
      channel: "http",
      headers: { authorization: `Bearer ${validToken}` },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const a = first.data as { actorId: string };
    const b = second.data as { actorId: string };
    expect(a.actorId).toBe(b.actorId);
  });
});
