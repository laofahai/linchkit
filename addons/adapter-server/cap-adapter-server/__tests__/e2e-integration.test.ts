/**
 * End-to-end integration tests: HTTP → GraphQL → ActionEngine → DrizzleDataProvider → PostgreSQL.
 *
 * Validates the full server stack with a real PostgreSQL database, covering:
 * - CRUD operations via GraphQL mutations/queries through HTTP
 * - Soft delete behavior
 * - Execution log recording
 * - Pagination
 * - Optimistic locking (_version)
 *
 * Requires a running PostgreSQL test instance on port 5434.
 * Skips gracefully when the database is not available.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { defineEntity } from "@linchkit/core";
import {
  closeDatabase,
  createActionExecutor,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleTable,
  InMemoryExecutionLogger,
  TableRegistry,
} from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Configuration ────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const PORT = 3091;
const GQL_URL = `http://localhost:${PORT}/graphql`;

const testSchema = defineEntity({
  name: "e2e_item",
  label: "E2E Test Item",
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number" },
    status: { type: "string" },
  },
});

const TABLE_NAME = testSchema.name;

// ── Database availability check ──────────────────────────

let db: PostgresJsDatabase | null = null;

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    await closeDatabase();
    return true;
  } catch {
    // Database not available — skip integration tests
    return false;
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("⏭ PostgreSQL not available on port 5434, skipping e2e integration tests");
}

// ── Test suite ───────────────────────────────────────────

describe.skipIf(!dbAvailable)("E2E Integration: HTTP → GraphQL → PostgreSQL", () => {
  let tableRegistry: TableRegistry;
  let provider: DrizzleDataProvider;
  let executionLogger: InMemoryExecutionLogger;
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin chaining produces complex inferred types
  let app: any;

  // ── GraphQL helper via real HTTP fetch ─────────────────

  async function gql(query: string, variables?: Record<string, unknown>) {
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
  }

  // ── Setup ─────────────────────────────────────────────

  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // Clean up from any previous run
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "${TABLE_NAME}" CASCADE`));

    // Register Drizzle table
    tableRegistry = new TableRegistry();
    const table = generateDrizzleTable(testSchema);
    tableRegistry.register(TABLE_NAME, table);

    // Create test table
    await db.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
        "id" text PRIMARY KEY NOT NULL,
        "tenant_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "created_by" text,
        "updated_by" text,
        "_version" integer DEFAULT 1 NOT NULL,
        "deleted_at" timestamp with time zone,
        "title" text NOT NULL,
        "amount" numeric,
        "status" text
      )
    `),
    );

    // Wire up providers
    provider = new DrizzleDataProvider(db, tableRegistry);
    executionLogger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: provider,
      executionLogger,
    });

    for (const action of generateCrudActions(testSchema)) {
      executor.registry.register(action);
    }

    // Build GraphQL schema (execution logs now served via system schema auto-generation)
    const graphqlSchema = buildGraphQLSchema([testSchema], {
      executor,
      dataProvider: provider,
    });

    // Start the real HTTP server
    app = createServer(graphqlSchema, {
      executor,
      executionLogger,
      dataProvider: provider,
    });
    app.listen(PORT);
  });

  afterAll(async () => {
    if (app) {
      app.stop();
    }
    if (db) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${TABLE_NAME}" CASCADE`));
      await closeDatabase();
    }
  });

  afterEach(async () => {
    if (db) {
      await db.execute(sql.raw(`TRUNCATE TABLE "${TABLE_NAME}"`));
    }
    executionLogger?.clear();
  });

  // ── 1. Create a record via GraphQL mutation ───────────

  test("create — inserts a record into PostgreSQL and returns system fields", async () => {
    const result = await gql(`
      mutation {
        createE2eItem(input: { title: "First Item", amount: 100 }) {
          id
          title
          amount
          created_at
          updated_at
          _version
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const record = result.data.createE2eItem as Record<string, unknown>;
    expect(record.id).toBeDefined();
    expect(typeof record.id).toBe("string");
    expect(record.title).toBe("First Item");
    expect(Number(record.amount)).toBe(100);
    expect(record._version).toBe(1);
    expect(record.created_at).toBeDefined();
    expect(record.updated_at).toBeDefined();
  });

  // ── 2. Query record list with pagination ──────────────

  test("list — returns paginated records from PostgreSQL", async () => {
    // Seed records
    for (let i = 1; i <= 5; i++) {
      await gql(`
        mutation {
          createE2eItem(input: { title: "Item ${i}", amount: ${i * 10} }) {
            id
          }
        }
      `);
    }

    // First page
    const page1 = await gql(`
      query {
        e2eItemList(page: 1, pageSize: 3) {
          items { id title amount }
          total
        }
      }
    `);

    expect(page1.errors).toBeUndefined();
    const list1 = page1.data.e2eItemList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list1.total).toBe(5);
    expect(list1.items.length).toBe(3);

    // Second page
    const page2 = await gql(`
      query {
        e2eItemList(page: 2, pageSize: 3) {
          items { id title }
          total
        }
      }
    `);

    expect(page2.errors).toBeUndefined();
    const list2 = page2.data.e2eItemList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list2.total).toBe(5);
    expect(list2.items.length).toBe(2);

    // No overlap between pages
    const page1Ids = new Set(list1.items.map((r) => r.id));
    for (const r of list2.items) {
      expect(page1Ids.has(r.id as string)).toBe(false);
    }
  });

  // ── 3. Update a record via GraphQL mutation ───────────

  test("update — modifies fields and increments _version", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "Original", amount: 50 }) {
          id
          _version
        }
      }
    `);
    const created = createResult.data.createE2eItem as Record<string, unknown>;
    const id = created.id as string;
    expect(created._version).toBe(1);

    // Update with optimistic locking
    const updateResult = await gql(`
      mutation {
        updateE2eItem(id: "${id}", input: { title: "Modified", amount: 75 }, _version: 1) {
          id
          title
          amount
          _version
          updated_at
        }
      }
    `);

    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateE2eItem as Record<string, unknown>;
    expect(updated.title).toBe("Modified");
    expect(Number(updated.amount)).toBe(75);
    expect(updated._version).toBe(2);
  });

  // ── 4. Get single record by ID ────────────────────────

  test("get — retrieves a specific record by ID", async () => {
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "Specific", amount: 999 }) {
          id
        }
      }
    `);
    const id = (createResult.data.createE2eItem as Record<string, unknown>).id as string;

    const getResult = await gql(`
      query {
        e2eItem(id: "${id}") {
          id
          title
          amount
          _version
          created_at
        }
      }
    `);

    expect(getResult.errors).toBeUndefined();
    const record = getResult.data.e2eItem as Record<string, unknown>;
    expect(record.id).toBe(id);
    expect(record.title).toBe("Specific");
    expect(Number(record.amount)).toBe(999);
    expect(record._version).toBe(1);
  });

  // ── 5. Soft delete — record hidden from queries ───────

  test("delete — soft-deletes record, hidden from get and list", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "To Delete" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createE2eItem as Record<string, unknown>).id as string;

    // Delete
    const deleteResult = await gql(`
      mutation {
        deleteE2eItem(id: "${id}")
      }
    `);
    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteE2eItem).toBe(true);

    // Get should return null
    const getResult = await gql(`
      query {
        e2eItem(id: "${id}") {
          id
        }
      }
    `);
    expect(getResult.errors).toBeUndefined();
    expect(getResult.data.e2eItem).toBeNull();

    // List should not include it
    const listResult = await gql(`
      query {
        e2eItemList {
          items { id }
          total
        }
      }
    `);
    expect(listResult.errors).toBeUndefined();
    const list = listResult.data.e2eItemList as { items: unknown[]; total: number };
    expect(list.total).toBe(0);
    expect(list.items.length).toBe(0);
  });

  // ── 6. Optimistic locking — stale version rejected ────

  test("update with stale _version — returns conflict error", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "Lock Test" }) {
          id
          _version
        }
      }
    `);
    const id = (createResult.data.createE2eItem as Record<string, unknown>).id as string;

    // First update: v1 → v2
    await gql(`
      mutation {
        updateE2eItem(id: "${id}", input: { title: "v2" }, _version: 1) {
          id _version
        }
      }
    `);

    // Second update with stale version 1 — should fail
    const staleResult = await gql(`
      mutation {
        updateE2eItem(id: "${id}", input: { title: "stale" }, _version: 1) {
          id _version
        }
      }
    `);

    expect(staleResult.errors).toBeDefined();
    expect(staleResult.errors?.length).toBeGreaterThan(0);
  });

  // ── 7. Execution log — mutations are recorded ─────────

  test("execution log — create and update mutations generate log entries", async () => {
    // Create a record
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "Logged Item", amount: 42 }) {
          id
        }
      }
    `);
    expect(createResult.errors).toBeUndefined();
    const id = (createResult.data.createE2eItem as Record<string, unknown>).id as string;

    // Update it
    const updateResult = await gql(`
      mutation {
        updateE2eItem(id: "${id}", input: { title: "Updated Logged" }, _version: 1) {
          id _version
        }
      }
    `);
    expect(updateResult.errors).toBeUndefined();

    // Check execution logs via InMemoryExecutionLogger (the legacy executionLogs
    // GraphQL query was removed; logs are now served via the system schema
    // execution_log through SystemDataProvider, which is not wired in this test)
    const entries = executionLogger.getAll();

    // Should have at least 2 entries (create + update)
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const actions = entries.map((e) => e.action);
    expect(actions).toContain("create_e2e_item");
    expect(actions).toContain("update_e2e_item");

    // All should be successful
    for (const entry of entries) {
      expect(entry.status).toBe("succeeded");
    }
  });

  // ── 8. Full CRUD lifecycle ────────────────────────────

  test("full lifecycle — create → get → list → update → delete → verify", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createE2eItem(input: { title: "Lifecycle", amount: 1000, status: "draft" }) {
          id title amount status _version
        }
      }
    `);
    expect(createResult.errors).toBeUndefined();
    const created = createResult.data.createE2eItem as Record<string, unknown>;
    const id = created.id as string;
    expect(created.title).toBe("Lifecycle");
    expect(created.status).toBe("draft");
    expect(created._version).toBe(1);

    // Get
    const getResult = await gql(`
      query { e2eItem(id: "${id}") { id title amount status _version } }
    `);
    expect(getResult.errors).toBeUndefined();
    const fetched = getResult.data.e2eItem as Record<string, unknown>;
    expect(fetched.title).toBe("Lifecycle");

    // List
    const listResult = await gql(`
      query { e2eItemList { items { id } total } }
    `);
    expect(listResult.errors).toBeUndefined();
    const list = listResult.data.e2eItemList as { items: unknown[]; total: number };
    expect(list.total).toBe(1);

    // Update
    const updateResult = await gql(`
      mutation {
        updateE2eItem(id: "${id}", input: { title: "Lifecycle Updated", status: "active" }, _version: 1) {
          id title status _version
        }
      }
    `);
    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateE2eItem as Record<string, unknown>;
    expect(updated.title).toBe("Lifecycle Updated");
    expect(updated.status).toBe("active");
    expect(updated._version).toBe(2);

    // Delete
    const deleteResult = await gql(`
      mutation { deleteE2eItem(id: "${id}") }
    `);
    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteE2eItem).toBe(true);

    // Verify hidden
    const verifyGet = await gql(`
      query { e2eItem(id: "${id}") { id } }
    `);
    expect(verifyGet.data.e2eItem).toBeNull();

    const verifyList = await gql(`
      query { e2eItemList { total } }
    `);
    expect((verifyList.data.e2eItemList as { total: number }).total).toBe(0);
  });

  // ── 9. Get non-existent record returns null ───────────

  test("get — returns null for non-existent ID", async () => {
    const result = await gql(`
      query { e2eItem(id: "does-not-exist") { id } }
    `);
    expect(result.errors).toBeUndefined();
    expect(result.data.e2eItem).toBeNull();
  });

  // ── 10. REST health check works alongside GraphQL ─────

  test("health endpoint — returns healthy status", async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});
