/**
 * E2E Test: Full CRUD lifecycle
 *
 * Validates create → query → update → verify update → delete → verify gone →
 * restore → verify restored, all via GraphQL mutations/queries through HTTP.
 *
 * Uses InMemoryStore for fast, deterministic testing without PostgreSQL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ────────────────────────────────────────────────

const departmentSchema: SchemaDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    code: { type: "string", required: true, label: "Code" },
    head: { type: "string", label: "Department Head" },
    budget: { type: "number", label: "Budget" },
    is_active: { type: "boolean", label: "Active" },
  },
};

// ── Setup ────────────────────────────────────────────────

const PORT = 32100;
const GQL_URL = `http://localhost:${PORT}/graphql`;

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  for (const action of generateCrudActions(departmentSchema)) {
    executor.registry.register(action);
  }

  const graphqlSchema = buildGraphQLSchema([departmentSchema], {
    executor,
    dataProvider: store,
  });
  app = createServer(graphqlSchema);
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("E2E CRUD lifecycle", () => {
  test("1. Create a department via GraphQL mutation", async () => {
    const result = await gql(`
      mutation {
        createDepartment(input: {
          name: "Engineering",
          code: "ENG",
          head: "Alice",
          budget: 500000
        }) {
          id name code head budget created_at updated_at _version
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const dept = result.data.createDepartment as Record<string, unknown>;
    expect(dept.id).toBeDefined();
    expect(typeof dept.id).toBe("string");
    expect(dept.name).toBe("Engineering");
    expect(dept.code).toBe("ENG");
    expect(dept.head).toBe("Alice");
    expect(dept.budget).toBe(500000);
    expect(dept._version).toBe(1);
    expect(dept.created_at).toBeDefined();
    expect(dept.updated_at).toBeDefined();
  });

  test("2. Query the department back by ID", async () => {
    // Create first
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "Sales", code: "SLS", budget: 200000 }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    // Query by ID
    const getResult = await gql(`
      query {
        department(id: "${id}") {
          id name code budget _version
        }
      }
    `);

    expect(getResult.errors).toBeUndefined();
    const dept = getResult.data.department as Record<string, unknown>;
    expect(dept.id).toBe(id);
    expect(dept.name).toBe("Sales");
    expect(dept.code).toBe("SLS");
    expect(dept.budget).toBe(200000);
    expect(dept._version).toBe(1);
  });

  test("3. Update the department", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "Marketing", code: "MKT", budget: 100000 }) {
          id _version
        }
      }
    `);
    const created = createResult.data.createDepartment as Record<string, unknown>;
    const id = created.id as string;

    // Update — include all fields to ensure full update semantics
    const updateResult = await gql(`
      mutation {
        updateDepartment(id: "${id}", input: { name: "Marketing & PR", code: "MKT", budget: 150000 }, _version: 1) {
          id name code budget _version
        }
      }
    `);

    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateDepartment as Record<string, unknown>;
    expect(updated.name).toBe("Marketing & PR");
    expect(updated.code).toBe("MKT");
    expect(updated.budget).toBe(150000);
    expect(updated._version).toBe(2);
  });

  test("4. Query to verify update persisted", async () => {
    // Create and update
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "HR", code: "HR", head: "Bob" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    await gql(`
      mutation {
        updateDepartment(id: "${id}", input: { name: "HR", code: "HR", head: "Charlie" }, _version: 1) {
          id
        }
      }
    `);

    // Verify
    const getResult = await gql(`
      query {
        department(id: "${id}") {
          id name head _version
        }
      }
    `);

    expect(getResult.errors).toBeUndefined();
    const dept = getResult.data.department as Record<string, unknown>;
    expect(dept.name).toBe("HR");
    expect(dept.head).toBe("Charlie");
    expect(dept._version).toBe(2);
  });

  test("5. Delete the department (soft delete)", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "Finance", code: "FIN" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    // Delete
    const deleteResult = await gql(`
      mutation {
        deleteDepartment(id: "${id}")
      }
    `);

    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteDepartment).toBe(true);
  });

  test("6. Verify deleted department is gone from queries", async () => {
    // Create and delete
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "Legal", code: "LEG" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    await gql(`mutation { deleteDepartment(id: "${id}") }`);

    // Get should return null
    const getResult = await gql(`
      query { department(id: "${id}") { id } }
    `);
    expect(getResult.errors).toBeUndefined();
    expect(getResult.data.department).toBeNull();

    // List should not include it
    const listResult = await gql(`
      query { departmentList { items { id } total } }
    `);
    expect(listResult.errors).toBeUndefined();
    const list = listResult.data.departmentList as { items: unknown[]; total: number };
    expect(list.total).toBe(0);
  });

  test("7. Restore soft-deleted department", async () => {
    // Create and delete
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "R&D", code: "RND", budget: 300000 }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    await gql(`mutation { deleteDepartment(id: "${id}") }`);

    // Verify hidden
    const beforeRestore = await gql(`
      query { department(id: "${id}") { id } }
    `);
    expect(beforeRestore.data.department).toBeNull();

    // Restore
    const restoreResult = await gql(`
      mutation {
        restoreDepartment(id: "${id}") {
          id name code budget
        }
      }
    `);

    expect(restoreResult.errors).toBeUndefined();
    const restored = restoreResult.data.restoreDepartment as Record<string, unknown>;
    expect(restored.id).toBe(id);
    expect(restored.name).toBe("R&D");
    expect(restored.code).toBe("RND");
    expect(restored.budget).toBe(300000);
  });

  test("8. Verify restored department is visible again", async () => {
    // Create, delete, restore
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "Operations", code: "OPS" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createDepartment as Record<string, unknown>).id as string;

    await gql(`mutation { deleteDepartment(id: "${id}") }`);
    await gql(`mutation { restoreDepartment(id: "${id}") { id } }`);

    // Get should work
    const getResult = await gql(`
      query { department(id: "${id}") { id name code } }
    `);
    expect(getResult.errors).toBeUndefined();
    const dept = getResult.data.department as Record<string, unknown>;
    expect(dept.id).toBe(id);
    expect(dept.name).toBe("Operations");

    // List should include it
    const listResult = await gql(`
      query { departmentList { items { id } total } }
    `);
    const list = listResult.data.departmentList as { items: unknown[]; total: number };
    expect(list.total).toBe(1);
  });

  test("9. Full lifecycle in a single flow", async () => {
    // Create
    const createResult = await gql(`
      mutation {
        createDepartment(input: { name: "QA", code: "QA", head: "Diana", budget: 75000 }) {
          id name code head budget _version
        }
      }
    `);
    expect(createResult.errors).toBeUndefined();
    const created = createResult.data.createDepartment as Record<string, unknown>;
    const id = created.id as string;
    expect(created.name).toBe("QA");
    expect(created._version).toBe(1);

    // Query back
    const getResult = await gql(`
      query { department(id: "${id}") { id name head budget _version } }
    `);
    expect((getResult.data.department as Record<string, unknown>).name).toBe("QA");

    // Update — include all required fields
    const updateResult = await gql(`
      mutation {
        updateDepartment(id: "${id}", input: { name: "Quality Assurance", code: "QA", head: "Diana", budget: 90000 }, _version: 1) {
          id name budget _version
        }
      }
    `);
    expect(updateResult.errors).toBeUndefined();
    const updated = updateResult.data.updateDepartment as Record<string, unknown>;
    expect(updated.name).toBe("Quality Assurance");
    expect(updated.budget).toBe(90000);
    expect(updated._version).toBe(2);

    // Verify update
    const verifyUpdate = await gql(`
      query { department(id: "${id}") { name budget _version } }
    `);
    expect((verifyUpdate.data.department as Record<string, unknown>).name).toBe(
      "Quality Assurance",
    );
    expect((verifyUpdate.data.department as Record<string, unknown>)._version).toBe(2);

    // Delete
    const deleteResult = await gql(`mutation { deleteDepartment(id: "${id}") }`);
    expect(deleteResult.data.deleteDepartment).toBe(true);

    // Verify gone
    const verifyGone = await gql(`query { department(id: "${id}") { id } }`);
    expect(verifyGone.data.department).toBeNull();

    // Restore
    const restoreResult = await gql(`
      mutation { restoreDepartment(id: "${id}") { id name budget } }
    `);
    expect(restoreResult.errors).toBeUndefined();
    const restored = restoreResult.data.restoreDepartment as Record<string, unknown>;
    expect(restored.name).toBe("Quality Assurance");
    expect(restored.budget).toBe(90000);

    // Verify restored
    const verifyRestored = await gql(`
      query { department(id: "${id}") { id name code head budget _version } }
    `);
    const final = verifyRestored.data.department as Record<string, unknown>;
    expect(final.name).toBe("Quality Assurance");
    expect(final.code).toBe("QA");
    expect(final.head).toBe("Diana");
  });

  test("10. List query returns multiple departments with pagination", async () => {
    // Create 5 departments
    for (let i = 1; i <= 5; i++) {
      await gql(`
        mutation {
          createDepartment(input: { name: "Dept ${i}", code: "D${i}" }) { id }
        }
      `);
    }

    // First page
    const page1 = await gql(`
      query { departmentList(page: 1, pageSize: 3) { items { id name } total } }
    `);
    expect(page1.errors).toBeUndefined();
    const list1 = page1.data.departmentList as { items: Record<string, unknown>[]; total: number };
    expect(list1.total).toBe(5);
    expect(list1.items.length).toBe(3);

    // Second page
    const page2 = await gql(`
      query { departmentList(page: 2, pageSize: 3) { items { id name } total } }
    `);
    const list2 = page2.data.departmentList as { items: Record<string, unknown>[]; total: number };
    expect(list2.total).toBe(5);
    expect(list2.items.length).toBe(2);

    // No overlap
    const page1Ids = new Set(list1.items.map((r) => r.id));
    for (const r of list2.items) {
      expect(page1Ids.has(r.id as string)).toBe(false);
    }
  });

  test("11. Get non-existent department returns null", async () => {
    const result = await gql(`
      query { department(id: "nonexistent_id") { id } }
    `);
    expect(result.errors).toBeUndefined();
    expect(result.data.department).toBeNull();
  });
});
