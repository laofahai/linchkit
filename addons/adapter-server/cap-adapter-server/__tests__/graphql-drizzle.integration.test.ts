/**
 * Integration tests for GraphQL + DrizzleDataProvider against a real PostgreSQL database.
 *
 * Validates that GraphQL queries and mutations work end-to-end through the
 * Action Engine with DrizzleDataProvider as the backing store.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL env var to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 *
 * Skips gracefully when no database is available (CI without PG won't fail).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { defineEntity, defineRelation } from "@linchkit/core";
import {
  closeDatabase,
  createActionExecutor,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleTable,
  TableRegistry,
} from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createYoga } from "graphql-yoga";
import type { GraphQLContext } from "../src/graphql/build-schema";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const testSchema = defineEntity({
  name: "gql_drizzle_test",
  label: "GraphQL Drizzle Test",
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number" },
    status: { type: "string" },
  },
});

const SCHEMA_NAME = testSchema.name;

// ── Connection check ─────────────────────────────────────────

let db: PostgresJsDatabase | null = null;
let tableRegistry: TableRegistry;
let provider: DrizzleDataProvider;

/**
 * Try to connect to the database.
 * Returns true if connection succeeds, false otherwise.
 */
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
  console.warn("PostgreSQL not available, skipping GraphQL + Drizzle integration tests");
}

// ── GraphQL helper ───────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: yoga generic types are complex
let yoga: any;

/**
 * Execute a GraphQL query/mutation via yoga.fetch() with optional context (tenantId).
 */
async function gql(
  query: string,
  variables?: Record<string, unknown>,
  context?: { tenantId?: string },
) {
  const body = JSON.stringify({ query, variables });

  // Build a request with optional tenant header
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (context?.tenantId) {
    headers["x-tenant-id"] = context.tenantId;
  }

  const response = await yoga.fetch("http://localhost/graphql", {
    method: "POST",
    headers,
    body,
  });

  return response.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("GraphQL + DrizzleDataProvider (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // Drop test table if it exists from a previous run
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "${SCHEMA_NAME}" CASCADE`));

    // Set up table registry
    tableRegistry = new TableRegistry();
    const table = generateDrizzleTable(testSchema);
    tableRegistry.register(SCHEMA_NAME, table);

    // Create test table via raw SQL (test fixture)
    await db.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA_NAME}" (
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

    // Set up DrizzleDataProvider
    provider = new DrizzleDataProvider(db, tableRegistry);

    // Set up ActionExecutor wired to DrizzleDataProvider
    const executor = createActionExecutor({ dataProvider: provider });
    for (const action of generateCrudActions(testSchema)) {
      executor.registry.register(action);
    }

    // Build GraphQL schema wired to real executor + data provider
    const graphqlSchema = buildGraphQLSchema([testSchema], {
      executor,
      dataProvider: provider,
    });

    // Create yoga instance with tenant context from x-tenant-id header
    yoga = createYoga({
      schema: graphqlSchema,
      graphqlEndpoint: "/graphql",
      context: async ({ request }: { request: Request }) => {
        const tenantId = request.headers.get("x-tenant-id") ?? undefined;
        return { tenantId } as GraphQLContext;
      },
    });
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${SCHEMA_NAME}" CASCADE`));
      // NOTE: Don't close database here — shared connection used by subsequent test suites.
      // closeDatabase() is called in the Link resolver suite's afterAll.
    }
    // Clean up generated test schema file
    try {
      const { unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      unlinkSync(join(process.cwd(), ".linchkit", "test-gql-schema.generated.ts"));
    } catch {
      // Ignore if already cleaned up
    }
  });

  afterEach(async () => {
    if (db) {
      await db.execute(sql.raw(`TRUNCATE TABLE "${SCHEMA_NAME}"`));
    }
  });

  // ── 1. Create mutation — system fields populated ──────────

  test("createGqlDrizzleTest mutation — returns record with id, created_at, _version=1", async () => {
    const result = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "Integration Record", amount: 42 }) {
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
    const record = result.data.createGqlDrizzleTest as Record<string, unknown>;
    expect(record.id).toBeDefined();
    expect(typeof record.id).toBe("string");
    expect(record.title).toBe("Integration Record");
    expect(record._version).toBe(1);
    expect(record.created_at).toBeDefined();
    expect(record.updated_at).toBeDefined();
  });

  // ── 2. Get query — retrieve created record ───────────────

  test("gqlDrizzleTest query — retrieves created record with all fields", async () => {
    // Create via GraphQL first
    const createResult = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "Fetch Me", amount: 99 }) {
          id
        }
      }
    `);
    const id = (createResult.data.createGqlDrizzleTest as Record<string, unknown>).id as string;

    // Get via GraphQL query
    const result = await gql(`
      query {
        gqlDrizzleTest(id: "${id}") {
          id
          title
          amount
          _version
          created_at
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const record = result.data.gqlDrizzleTest as Record<string, unknown>;
    expect(record.id).toBe(id);
    expect(record.title).toBe("Fetch Me");
    // PG doublePrecision returns number via GraphQL Float type
    expect(Number(record.amount)).toBe(99);
    expect(record._version).toBe(1);
  });

  // ── 3. List query — paginated results from real DB ────────

  test("gqlDrizzleTestList query — returns paginated results from real DB", async () => {
    // Seed 5 records
    for (let i = 1; i <= 5; i++) {
      await gql(`
        mutation {
          createGqlDrizzleTest(input: { title: "Item ${i}" }) {
            id
          }
        }
      `);
    }

    // Query first page
    const page1 = await gql(`
      query {
        gqlDrizzleTestList(page: 1, pageSize: 2) {
          items {
            id
            title
          }
          total
        }
      }
    `);

    expect(page1.errors).toBeUndefined();
    const list1 = page1.data.gqlDrizzleTestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list1.items.length).toBe(2);
    expect(list1.total).toBe(5);

    // Query second page
    const page2 = await gql(`
      query {
        gqlDrizzleTestList(page: 2, pageSize: 2) {
          items {
            id
            title
          }
          total
        }
      }
    `);

    expect(page2.errors).toBeUndefined();
    const list2 = page2.data.gqlDrizzleTestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list2.items.length).toBe(2);
    expect(list2.total).toBe(5);

    // Pages should not overlap
    const page1Ids = new Set(list1.items.map((r) => r.id));
    for (const r of list2.items) {
      expect(page1Ids.has(r.id as string)).toBe(false);
    }
  });

  // ── 4. Update mutation — verify _version increment ────────

  test("updateGqlDrizzleTest mutation — updates fields and increments _version", async () => {
    // Create a record
    const createResult = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "Original Title", amount: 10 }) {
          id
          _version
        }
      }
    `);
    const created = createResult.data.createGqlDrizzleTest as Record<string, unknown>;
    const id = created.id as string;
    expect(created._version).toBe(1);

    // Update with _version for optimistic locking
    const updateResult = await gql(`
      mutation {
        updateGqlDrizzleTest(id: "${id}", input: { title: "Updated Title", amount: 20 }, _version: 1) {
          id
          title
          amount
          _version
        }
      }
    `);

    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateGqlDrizzleTest as Record<string, unknown>;
    expect(updated.title).toBe("Updated Title");
    expect(Number(updated.amount)).toBe(20);
    expect(updated._version).toBe(2);
  });

  // ── 5. Update with stale _version — conflict error ────────

  test("updateGqlDrizzleTest with stale _version — returns error", async () => {
    // Create a record
    const createResult = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "Conflict Test" }) {
          id
          _version
        }
      }
    `);
    const id = (createResult.data.createGqlDrizzleTest as Record<string, unknown>).id as string;

    // First update: version 1 → 2
    await gql(`
      mutation {
        updateGqlDrizzleTest(id: "${id}", input: { title: "v2" }, _version: 1) {
          id
          _version
        }
      }
    `);

    // Second update with stale version 1 — should fail
    const staleResult = await gql(`
      mutation {
        updateGqlDrizzleTest(id: "${id}", input: { title: "stale" }, _version: 1) {
          id
          _version
        }
      }
    `);

    // GraphQL wraps errors — check for error in response
    expect(staleResult.errors).toBeDefined();
    expect(staleResult.errors?.length).toBeGreaterThan(0);
  });

  // ── 6. Delete mutation — soft-delete hides from queries ───

  test("deleteGqlDrizzleTest mutation — soft-deletes record, hidden from queries", async () => {
    // Create a record
    const createResult = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "To Delete" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createGqlDrizzleTest as Record<string, unknown>).id as string;

    // Delete via GraphQL
    const deleteResult = await gql(`
      mutation {
        deleteGqlDrizzleTest(id: "${id}")
      }
    `);

    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteGqlDrizzleTest).toBe(true);

    // Get should return null (soft-deleted, not found)
    const getResult = await gql(`
      query {
        gqlDrizzleTest(id: "${id}") {
          id
        }
      }
    `);

    expect(getResult.errors).toBeUndefined();
    expect(getResult.data.gqlDrizzleTest).toBeNull();

    // List should not include it
    const listResult = await gql(`
      query {
        gqlDrizzleTestList {
          items {
            id
          }
          total
        }
      }
    `);

    expect(listResult.errors).toBeUndefined();
    const list = listResult.data.gqlDrizzleTestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list.total).toBe(0);
    expect(list.items.length).toBe(0);
  });

  // ── 7. Tenant isolation via GraphQL context ───────────────

  test("tenant isolation — records from other tenants not visible via GraphQL", async () => {
    // Create records with different tenants directly via data provider
    // (GraphQL create doesn't expose tenant_id in input, so use provider directly)
    await provider.create(SCHEMA_NAME, { title: "Tenant A Record 1", tenant_id: "tenant-a" });
    await provider.create(SCHEMA_NAME, { title: "Tenant A Record 2", tenant_id: "tenant-a" });
    await provider.create(SCHEMA_NAME, { title: "Tenant B Record 1", tenant_id: "tenant-b" });

    // Query as tenant-a — should only see tenant-a records
    const tenantAResult = await gql(
      `
      query {
        gqlDrizzleTestList {
          items {
            id
            title
          }
          total
        }
      }
    `,
      undefined,
      { tenantId: "tenant-a" },
    );

    expect(tenantAResult.errors).toBeUndefined();
    const tenantAList = tenantAResult.data.gqlDrizzleTestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(tenantAList.total).toBe(2);
    expect(tenantAList.items.length).toBe(2);
    for (const item of tenantAList.items) {
      expect((item.title as string).startsWith("Tenant A")).toBe(true);
    }

    // Query as tenant-b — should only see tenant-b records
    const tenantBResult = await gql(
      `
      query {
        gqlDrizzleTestList {
          items {
            id
            title
          }
          total
        }
      }
    `,
      undefined,
      { tenantId: "tenant-b" },
    );

    expect(tenantBResult.errors).toBeUndefined();
    const tenantBList = tenantBResult.data.gqlDrizzleTestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(tenantBList.total).toBe(1);
    expect(tenantBList.items.length).toBe(1);
    expect((tenantBList.items[0].title as string).startsWith("Tenant B")).toBe(true);
  });

  // ── 8. Tenant isolation — get by ID respects tenant ───────

  test("tenant isolation — get by ID returns null for other tenant's record", async () => {
    // Create a record as tenant-a
    const created = await provider.create(SCHEMA_NAME, {
      title: "Tenant A Only",
      tenant_id: "tenant-a",
    });
    const id = created.id as string;

    // Get as tenant-a — should succeed
    const tenantAGet = await gql(
      `
      query {
        gqlDrizzleTest(id: "${id}") {
          id
          title
        }
      }
    `,
      undefined,
      { tenantId: "tenant-a" },
    );

    expect(tenantAGet.errors).toBeUndefined();
    const record = tenantAGet.data.gqlDrizzleTest as Record<string, unknown>;
    expect(record).not.toBeNull();
    expect(record.title).toBe("Tenant A Only");

    // Get as tenant-b — should return null (not found from tenant-b perspective)
    const tenantBGet = await gql(
      `
      query {
        gqlDrizzleTest(id: "${id}") {
          id
          title
        }
      }
    `,
      undefined,
      { tenantId: "tenant-b" },
    );

    expect(tenantBGet.errors).toBeUndefined();
    expect(tenantBGet.data.gqlDrizzleTest).toBeNull();
  });

  // ── 9. Get query returns null for non-existent record ─────

  test("gqlDrizzleTest query — returns null for non-existent ID", async () => {
    const result = await gql(`
      query {
        gqlDrizzleTest(id: "non-existent-id") {
          id
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    expect(result.data.gqlDrizzleTest).toBeNull();
  });

  // ── 10. Full CRUD lifecycle via GraphQL ───────────────────

  test("full CRUD lifecycle — create → get → update → delete → verify hidden", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createGqlDrizzleTest(input: { title: "Lifecycle Test", amount: 100 }) {
          id
          title
          amount
          _version
        }
      }
    `);
    expect(createResult.errors).toBeUndefined();
    const created = createResult.data.createGqlDrizzleTest as Record<string, unknown>;
    const id = created.id as string;
    expect(created._version).toBe(1);

    // Get
    const getResult = await gql(`
      query {
        gqlDrizzleTest(id: "${id}") {
          id
          title
          amount
          _version
        }
      }
    `);
    expect(getResult.errors).toBeUndefined();
    const fetched = getResult.data.gqlDrizzleTest as Record<string, unknown>;
    expect(fetched.title).toBe("Lifecycle Test");
    expect(Number(fetched.amount)).toBe(100);

    // Update
    const updateResult = await gql(`
      mutation {
        updateGqlDrizzleTest(id: "${id}", input: { title: "Updated Lifecycle" }, _version: 1) {
          id
          title
          _version
        }
      }
    `);
    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateGqlDrizzleTest as Record<string, unknown>;
    expect(updated.title).toBe("Updated Lifecycle");
    expect(updated._version).toBe(2);

    // Delete
    const deleteResult = await gql(`
      mutation {
        deleteGqlDrizzleTest(id: "${id}")
      }
    `);
    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteGqlDrizzleTest).toBe(true);

    // Verify hidden from queries
    const verifyResult = await gql(`
      query {
        gqlDrizzleTest(id: "${id}") {
          id
        }
      }
    `);
    expect(verifyResult.errors).toBeUndefined();
    expect(verifyResult.data.gqlDrizzleTest).toBeNull();
  });
});

// ── Link resolver integration tests ─────────────────────────

const deptSchema = defineEntity({
  name: "link_dept",
  label: "Department",
  fields: {
    name: { type: "string", required: true },
  },
});

const prSchema = defineEntity({
  name: "link_pr",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number" },
    // FK column for the many_to_one link to department.
    // In production this is generated by generateRelationColumns(); here we declare it
    // explicitly so generateDrizzleTable() includes it in the Drizzle table definition,
    // allowing DrizzleDataProvider to read/write it.
    department_id: { type: "string" },
  },
});

const prToDeptLink = defineRelation({
  name: "link_pr_to_link_dept",
  from: "link_pr",
  to: "link_dept",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "purchase_requests",
  label: {
    from: "Department",
    to: "Purchase Requests",
  },
});

describe.skipIf(!dbAvailable)("GraphQL Relation resolvers (integration)", () => {
  let linkProvider: DrizzleDataProvider;
  // biome-ignore lint/suspicious/noExplicitAny: yoga generic types are complex
  let linkYoga: any;

  /** Execute a GraphQL query/mutation via the link-specific yoga instance. */
  async function linkGql(query: string, variables?: Record<string, unknown>) {
    const body = JSON.stringify({ query, variables });
    const response = await linkYoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return response.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
  }

  beforeAll(async () => {
    // Reuse the module-level db connection (singleton pattern)
    if (!db) {
      db = createDatabase({ url: DATABASE_URL });
    }

    // Drop tables from any previous run
    await db.execute(sql.raw('DROP TABLE IF EXISTS "link_pr" CASCADE'));
    await db.execute(sql.raw('DROP TABLE IF EXISTS "link_dept" CASCADE'));

    // Create department table
    await db?.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS "link_dept" (
        "id" text PRIMARY KEY NOT NULL,
        "tenant_id" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "created_by" text,
        "updated_by" text,
        "_version" integer DEFAULT 1 NOT NULL,
        "deleted_at" timestamp with time zone,
        "name" text NOT NULL
      )
    `),
    );

    // Create purchase_request table with FK column for the link
    await db?.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS "link_pr" (
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
        "department_id" text REFERENCES "link_dept"("id")
      )
    `),
    );

    // Set up table registry
    const linkTableRegistry = new TableRegistry();
    linkTableRegistry.register("link_dept", generateDrizzleTable(deptSchema));
    linkTableRegistry.register("link_pr", generateDrizzleTable(prSchema));

    // Set up data provider
    // biome-ignore lint/style/noNonNullAssertion: db is guaranteed to be set in beforeAll
    linkProvider = new DrizzleDataProvider(db!, linkTableRegistry);

    // Set up action executor with CRUD actions for both schemas
    const linkExecutor = createActionExecutor({ dataProvider: linkProvider });
    for (const action of generateCrudActions(deptSchema)) {
      linkExecutor.registry.register(action);
    }
    for (const action of generateCrudActions(prSchema)) {
      linkExecutor.registry.register(action);
    }

    // Build GraphQL schema with link definitions
    const graphqlSchema = buildGraphQLSchema([deptSchema, prSchema], {
      executor: linkExecutor,
      dataProvider: linkProvider,
      relations: [prToDeptLink],
    });

    // Create yoga instance — include dataProvider in context for relation resolvers
    linkYoga = createYoga({
      schema: graphqlSchema,
      graphqlEndpoint: "/graphql",
      context: async () => {
        return { dataProvider: linkProvider } as GraphQLContext;
      },
    });
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw('DROP TABLE IF EXISTS "link_pr" CASCADE'));
      await db.execute(sql.raw('DROP TABLE IF EXISTS "link_dept" CASCADE'));
      await closeDatabase();
    }
  });

  afterEach(async () => {
    if (db) {
      // Truncate in correct order (child first to avoid FK violations)
      await db.execute(sql.raw('TRUNCATE TABLE "link_pr" CASCADE'));
      await db.execute(sql.raw('TRUNCATE TABLE "link_dept" CASCADE'));
    }
  });

  // ── 1. Create department and purchase request with link ──────

  test("create department and purchase request linked via FK", async () => {
    // Create a department
    const deptResult = await linkGql(`
      mutation {
        createLinkDept(input: { name: "Engineering" }) {
          id
          name
        }
      }
    `);

    expect(deptResult.errors).toBeUndefined();
    const dept = deptResult.data.createLinkDept as Record<string, unknown>;
    expect(dept.id).toBeDefined();
    expect(dept.name).toBe("Engineering");

    // Create a purchase request referencing the department via the FK column
    // The FK column is `department_id` (generated by link convention: {to}_id)
    // We insert via data provider since GraphQL input type doesn't include FK columns
    const pr = await linkProvider.create("link_pr", {
      title: "Buy laptops",
      amount: 5000,
      department_id: dept.id,
    });

    expect(pr.id).toBeDefined();
    expect(pr.title).toBe("Buy laptops");
    expect(pr.department_id).toBe(dept.id);
  });

  // ── 2. Forward navigation: purchase_request → department ────

  test("forward navigation — purchase request resolves linked department", async () => {
    // Create department
    const deptResult = await linkGql(`
      mutation {
        createLinkDept(input: { name: "Marketing" }) {
          id
          name
        }
      }
    `);
    const dept = deptResult.data.createLinkDept as Record<string, unknown>;
    const deptId = dept.id as string;

    // Create purchase request with FK
    const pr = await linkProvider.create("link_pr", {
      title: "Conference booth",
      amount: 12000,
      department_id: deptId,
    });

    // Query purchase request with forward link field (department)
    const result = await linkGql(`
      query {
        linkPr(id: "${pr.id}") {
          id
          title
          amount
          department {
            id
            name
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const prRecord = result.data.linkPr as Record<string, unknown>;
    expect(prRecord.title).toBe("Conference booth");

    const resolvedDept = prRecord.department as Record<string, unknown>;
    expect(resolvedDept).not.toBeNull();
    expect(resolvedDept.id).toBe(deptId);
    expect(resolvedDept.name).toBe("Marketing");
  });

  // ── 3. Reverse navigation: department → purchase_requests ───

  test("reverse navigation — department resolves linked purchase requests", async () => {
    // Create department
    const deptResult = await linkGql(`
      mutation {
        createLinkDept(input: { name: "Finance" }) {
          id
          name
        }
      }
    `);
    const dept = deptResult.data.createLinkDept as Record<string, unknown>;
    const deptId = dept.id as string;

    // Create two purchase requests for this department
    await linkProvider.create("link_pr", {
      title: "Accounting software",
      amount: 3000,
      department_id: deptId,
    });
    await linkProvider.create("link_pr", {
      title: "Audit services",
      amount: 8000,
      department_id: deptId,
    });

    // Create a third purchase request for a different department (should NOT appear)
    const otherDeptResult = await linkGql(`
      mutation {
        createLinkDept(input: { name: "HR" }) {
          id
        }
      }
    `);
    const otherDeptId = (otherDeptResult.data.createLinkDept as Record<string, unknown>).id;
    await linkProvider.create("link_pr", {
      title: "Recruiting platform",
      amount: 2000,
      department_id: otherDeptId,
    });

    // Query department with reverse link field (purchaseRequests — camelCase of toName)
    const result = await linkGql(`
      query {
        linkDept(id: "${deptId}") {
          id
          name
          purchaseRequests {
            id
            title
            amount
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const deptRecord = result.data.linkDept as Record<string, unknown>;
    expect(deptRecord.name).toBe("Finance");

    const purchaseRequests = deptRecord.purchaseRequests as Array<Record<string, unknown>>;
    expect(purchaseRequests).toBeDefined();
    expect(purchaseRequests.length).toBe(2);

    const titles = purchaseRequests.map((pr) => pr.title).sort();
    expect(titles).toEqual(["Accounting software", "Audit services"]);
  });

  // ── 4. Forward navigation returns null when no FK set ───────

  test("forward navigation — returns null when FK is not set", async () => {
    // Create a purchase request without department reference
    const pr = await linkProvider.create("link_pr", {
      title: "Standalone request",
      amount: 100,
    });

    const result = await linkGql(`
      query {
        linkPr(id: "${pr.id}") {
          id
          title
          department {
            id
            name
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const prRecord = result.data.linkPr as Record<string, unknown>;
    expect(prRecord.title).toBe("Standalone request");
    expect(prRecord.department).toBeNull();
  });

  // ── 5. Reverse navigation returns empty array when no children ──

  test("reverse navigation — returns empty array when no linked records exist", async () => {
    // Create department with no purchase requests
    const deptResult = await linkGql(`
      mutation {
        createLinkDept(input: { name: "Empty Department" }) {
          id
          name
        }
      }
    `);
    const dept = deptResult.data.createLinkDept as Record<string, unknown>;

    const result = await linkGql(`
      query {
        linkDept(id: "${dept.id}") {
          id
          name
          purchaseRequests {
            id
            title
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const deptRecord = result.data.linkDept as Record<string, unknown>;
    expect(deptRecord.name).toBe("Empty Department");

    const purchaseRequests = deptRecord.purchaseRequests as Array<Record<string, unknown>>;
    expect(purchaseRequests).toBeDefined();
    expect(purchaseRequests.length).toBe(0);
  });
});
