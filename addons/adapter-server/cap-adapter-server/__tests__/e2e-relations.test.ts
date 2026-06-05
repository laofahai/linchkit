/**
 * E2E Test: Link / relationship integrity
 *
 * Validates bidirectional link resolution through GraphQL:
 * - Create a department and a purchase_request with department_id
 * - Query purchase_request, verify department is resolved
 * - Query department's related purchase_requests
 * - Delete department, verify FK behavior
 *
 * Uses InMemoryStore with link definitions for deterministic testing.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityDefinition, RelationDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema definitions ────────────────────────────────────

const departmentSchema: EntityDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    code: { type: "string", required: true, label: "Code" },
  },
};

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    department_id: { type: "string", label: "Department ID" },
  },
};

// ── Link definition ──────────────────────────────────────

const deptPurchaseLink: RelationDefinition = {
  name: "department_purchase_requests",
  from: "department",
  to: "purchase_request",
  cardinality: "one_to_many",
  fromName: "purchase_requests",
  toName: "department",
  label: {
    from: "Purchase Requests",
    to: "Department",
  },
};

// ── Setup ────────────────────────────────────────────────

// In-process, port-free: this URL only supplies a path to `new Request(...)` for
// `app.handle` — no socket is bound, so a dummy domain is used (no real port).
const GQL_URL = "http://local.test/graphql";

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  const schemas = [departmentSchema, purchaseRequestSchema];
  for (const schema of schemas) {
    for (const action of generateCrudActions(schema)) {
      executor.registry.register(action);
    }
  }

  const schemaMap = new Map<string, EntityDefinition>();
  schemaMap.set("department", departmentSchema);
  schemaMap.set("purchase_request", purchaseRequestSchema);

  const graphqlSchema = buildGraphQLSchema(schemas, {
    executor,
    dataProvider: store,
    relations: [deptPurchaseLink],
  });

  app = createServer(graphqlSchema, {
    dataProvider: store,
    schemaMap,
  });
});

beforeEach(() => {
  store.clear();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string) {
  const res = await app.handle(
    new Request(GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("E2E relation integrity", () => {
  test("1. Create a department and a purchase_request referencing it", async () => {
    // Create department
    const deptResult = await gql(`
      mutation {
        createDepartment(input: { name: "Engineering", code: "ENG" }) {
          id name code
        }
      }
    `);
    expect(deptResult.errors).toBeUndefined();
    const dept = deptResult.data.createDepartment as Record<string, unknown>;
    const deptId = dept.id as string;
    expect(dept.name).toBe("Engineering");

    // Create purchase_request with department_id
    const prResult = await gql(`
      mutation {
        createPurchaseRequest(input: {
          title: "New Laptops",
          amount: 15000,
          department_id: "${deptId}"
        }) {
          id title amount department_id
        }
      }
    `);
    expect(prResult.errors).toBeUndefined();
    const pr = prResult.data.createPurchaseRequest as Record<string, unknown>;
    expect(pr.title).toBe("New Laptops");
    expect(pr.department_id).toBe(deptId);
  });

  test("2. Query purchase_request with linked department resolved", async () => {
    // Seed data directly
    await store.create("department", { id: "dept_1", name: "Sales", code: "SLS" });
    await store.create("purchase_request", {
      id: "pr_1",
      title: "CRM License",
      amount: 3000,
      department_id: "dept_1",
    });

    // Query purchase_request — the link resolver should resolve department
    const result = await gql(`
      query {
        purchaseRequest(id: "pr_1") {
          id
          title
          amount
          department_id
          department {
            id
            name
            code
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const pr = result.data.purchaseRequest as Record<string, unknown>;
    expect(pr.title).toBe("CRM License");
    expect(pr.department_id).toBe("dept_1");

    // Verify linked department resolved
    const dept = pr.department as Record<string, unknown>;
    expect(dept).toBeDefined();
    expect(dept.id).toBe("dept_1");
    expect(dept.name).toBe("Sales");
    expect(dept.code).toBe("SLS");
  });

  test("3. Query department with related purchase_requests", async () => {
    // Seed data
    await store.create("department", { id: "dept_2", name: "Marketing", code: "MKT" });
    await store.create("purchase_request", {
      id: "pr_2",
      title: "Ad Campaign",
      amount: 10000,
      department_id: "dept_2",
    });
    await store.create("purchase_request", {
      id: "pr_3",
      title: "Event Booth",
      amount: 5000,
      department_id: "dept_2",
    });

    // Query department with its purchase_requests
    const result = await gql(`
      query {
        department(id: "dept_2") {
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
    const dept = result.data.department as Record<string, unknown>;
    expect(dept.name).toBe("Marketing");

    const prs = dept.purchaseRequests as Array<Record<string, unknown>>;
    expect(prs).toBeDefined();
    expect(prs.length).toBe(2);

    const titles = prs.map((pr) => pr.title).sort();
    expect(titles).toEqual(["Ad Campaign", "Event Booth"]);
  });

  test("4. Purchase request with non-existent department_id returns null for department", async () => {
    await store.create("purchase_request", {
      id: "pr_orphan",
      title: "Orphan PR",
      amount: 100,
      department_id: "nonexistent_dept",
    });

    const result = await gql(`
      query {
        purchaseRequest(id: "pr_orphan") {
          id
          title
          department_id
          department {
            id
            name
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const pr = result.data.purchaseRequest as Record<string, unknown>;
    expect(pr.department_id).toBe("nonexistent_dept");
    expect(pr.department).toBeNull();
  });

  test("5. Multiple purchase_requests for one department", async () => {
    // Create department via GraphQL
    const deptResult = await gql(`
      mutation {
        createDepartment(input: { name: "IT", code: "IT" }) { id }
      }
    `);
    const deptId = (deptResult.data.createDepartment as Record<string, unknown>).id as string;

    // Create 3 purchase requests for the department
    for (const title of ["Servers", "Cables", "Switches"]) {
      await gql(`
        mutation {
          createPurchaseRequest(input: { title: "${title}", amount: 1000, department_id: "${deptId}" }) { id }
        }
      `);
    }

    // Query department's purchase requests
    const result = await gql(`
      query {
        department(id: "${deptId}") {
          id name
          purchaseRequests {
            id title
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const dept = result.data.department as Record<string, unknown>;
    const prs = dept.purchaseRequests as Array<Record<string, unknown>>;
    expect(prs.length).toBe(3);
  });

  test("6. Department with no purchase_requests returns empty array", async () => {
    await store.create("department", { id: "dept_empty", name: "Empty Dept", code: "EMP" });

    const result = await gql(`
      query {
        department(id: "dept_empty") {
          id name
          purchaseRequests {
            id title
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const dept = result.data.department as Record<string, unknown>;
    const prs = dept.purchaseRequests as Array<Record<string, unknown>>;
    expect(prs).toBeDefined();
    expect(prs.length).toBe(0);
  });

  test("7. Delete department — purchase_requests still queryable with null department", async () => {
    // Seed data
    await store.create("department", { id: "dept_del", name: "Closing Dept", code: "CLS" });
    await store.create("purchase_request", {
      id: "pr_del",
      title: "Last Purchase",
      amount: 500,
      department_id: "dept_del",
    });

    // Delete department (soft delete)
    const deleteResult = await gql(`
      mutation { deleteDepartment(id: "dept_del") }
    `);
    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data.deleteDepartment).toBe(true);

    // Purchase request still exists
    const prResult = await gql(`
      query {
        purchaseRequest(id: "pr_del") {
          id title department_id
          department {
            id name
          }
        }
      }
    `);

    expect(prResult.errors).toBeUndefined();
    const pr = prResult.data.purchaseRequest as Record<string, unknown>;
    expect(pr.title).toBe("Last Purchase");
    expect(pr.department_id).toBe("dept_del");
    // Department is soft-deleted, so link resolver returns null
    expect(pr.department).toBeNull();
  });

  test("8. Link resolution in list queries", async () => {
    // Seed departments and purchase requests
    await store.create("department", { id: "dept_a", name: "Dept A", code: "A" });
    await store.create("department", { id: "dept_b", name: "Dept B", code: "B" });
    await store.create("purchase_request", {
      id: "pr_a1",
      title: "PR for A",
      amount: 100,
      department_id: "dept_a",
    });
    await store.create("purchase_request", {
      id: "pr_b1",
      title: "PR for B",
      amount: 200,
      department_id: "dept_b",
    });

    // List purchase requests with department resolved
    const result = await gql(`
      query {
        purchaseRequestList {
          items {
            id title
            department {
              id name
            }
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const list = result.data.purchaseRequestList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(list.total).toBe(2);

    // Each PR should have its department resolved
    for (const pr of list.items) {
      const dept = pr.department as Record<string, unknown> | null;
      expect(dept).not.toBeNull();
      expect(dept?.id).toBeDefined();
      expect(dept?.name).toBeDefined();
    }
  });
});
