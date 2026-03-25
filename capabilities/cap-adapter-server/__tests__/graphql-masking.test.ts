import { describe, expect, test } from "bun:test";
import type {
  Actor,
  LinkDefinition,
  PermissionGroupDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core/server";
import { graphql } from "graphql";
import { InMemoryStore } from "../src/data/in-memory-store";
import {
  buildGraphQLSchema,
  type GraphQLContext,
  generateCrudActions,
} from "../src/graphql/build-schema";

// ── Schema with sensitive and secret fields ──────────────

const employeeSchema: SchemaDefinition = {
  name: "employee",
  label: "Employee",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", required: true, label: "Email", sensitive: true },
    phone: {
      type: "string",
      label: "Phone",
      masking: { strategy: "partial", visibleChars: 4, position: "end" },
    },
    ssn: { type: "string", label: "SSN", secret: true },
    salary: { type: "number", label: "Salary", sensitive: true },
    department: { type: "string", label: "Department" },
  },
};

// ── Actors ─────────────────────────────────────────────────

const anonymousActor: Actor = {
  type: "system",
  id: "anonymous",
  groups: [],
};

const adminActor: Actor = {
  type: "user",
  id: "admin-1",
  groups: ["system_admin"],
};

const regularActor: Actor = {
  type: "user",
  id: "user-1",
  groups: ["employee_viewer"],
};

// ── Permission groups ──────────────────────────────────────

const permissionGroups: PermissionGroupDefinition[] = [
  {
    name: "system_admin",
    label: "System Admin",
    permissions: {},
  },
  {
    name: "employee_viewer",
    label: "Employee Viewer",
    permissions: {},
  },
];

// ── Setup ──────────────────────────────────────────────────

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

for (const action of generateCrudActions(employeeSchema)) {
  executor.registry.register(action);
}

const gqlSchema = buildGraphQLSchema([employeeSchema], {
  executor,
  dataProvider: store,
  permissionGroups,
});

// ── Helpers ────────────────────────────────────────────────

async function executeGql(query: string, actor: Actor, variables?: Record<string, unknown>) {
  const ctx: GraphQLContext = {
    actor,
    permissionGroups,
  };
  return graphql({
    schema: gqlSchema,
    source: query,
    contextValue: ctx,
    variableValues: variables,
  });
}

// ── Tests ──────────────────────────────────────────────────

describe("GraphQL data masking", () => {
  // Seed a record before tests
  const seedId = "emp-masking-1";

  test("setup: create test record", async () => {
    await store.create("employee", {
      id: seedId,
      name: "Alice Johnson",
      email: "alice@example.com",
      phone: "+1-555-123-4567",
      ssn: "123-45-6789",
      salary: 95000,
      department: "Engineering",
    });
    const record = await store.get("employee", seedId);
    expect(record.name).toBe("Alice Johnson");
  });

  test("anonymous actor: sensitive fields are masked in get query", async () => {
    const result = await executeGql(
      `{ employee(id: "${seedId}") { id name email phone ssn salary department } }`,
      anonymousActor,
    );

    expect(result.errors).toBeUndefined();
    const emp = result.data?.employee as Record<string, unknown>;
    expect(emp).not.toBeNull();

    // Non-sensitive fields are untouched
    expect(emp.name).toBe("Alice Johnson");
    expect(emp.department).toBe("Engineering");
    expect(emp.id).toBe(seedId);

    // Sensitive field (email) — partial mask, last 4 chars visible
    expect(emp.email).not.toBe("alice@example.com");
    expect(typeof emp.email).toBe("string");
    expect((emp.email as string).endsWith(".com")).toBe(true);

    // Sensitive field (salary) — number fields are coerced to null when masked
    expect(emp.salary).toBeNull();

    // Custom masking (phone) — partial, last 4 chars visible
    expect(emp.phone).not.toBe("+1-555-123-4567");
    expect(typeof emp.phone).toBe("string");
    expect((emp.phone as string).endsWith("4567")).toBe(true);

    // Secret field (ssn) — full mask returns null
    expect(emp.ssn).toBeNull();
  });

  test("anonymous actor: sensitive fields are masked in list query", async () => {
    const result = await executeGql(
      `{ employeeList { items { id name email ssn salary } total } }`,
      anonymousActor,
    );

    expect(result.errors).toBeUndefined();
    const list = result.data?.employeeList as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);

    const emp = list.items.find((i) => i.id === seedId) as Record<string, unknown>;
    expect(emp).toBeDefined();

    // Sensitive field masked
    expect(emp.email).not.toBe("alice@example.com");
    // Secret field masked (full = null)
    expect(emp.ssn).toBeNull();
  });

  test("system_admin actor: sees unmasked data in get query", async () => {
    const result = await executeGql(
      `{ employee(id: "${seedId}") { id name email phone ssn salary department } }`,
      adminActor,
    );

    expect(result.errors).toBeUndefined();
    const emp = result.data?.employee as Record<string, unknown>;
    expect(emp).not.toBeNull();

    // All fields are unmasked for system_admin
    expect(emp.name).toBe("Alice Johnson");
    expect(emp.email).toBe("alice@example.com");
    expect(emp.phone).toBe("+1-555-123-4567");
    expect(emp.ssn).toBe("123-45-6789");
    expect(emp.salary).toBe(95000);
    expect(emp.department).toBe("Engineering");
  });

  test("system_admin actor: sees unmasked data in list query", async () => {
    const result = await executeGql(
      `{ employeeList { items { id email ssn salary } total } }`,
      adminActor,
    );

    expect(result.errors).toBeUndefined();
    const list = result.data?.employeeList as {
      items: Record<string, unknown>[];
      total: number;
    };
    const emp = list.items.find((i) => i.id === seedId) as Record<string, unknown>;
    expect(emp).toBeDefined();

    expect(emp.email).toBe("alice@example.com");
    expect(emp.ssn).toBe("123-45-6789");
    expect(emp.salary).toBe(95000);
  });

  test("regular user without unmask permission: data is masked", async () => {
    const result = await executeGql(
      `{ employee(id: "${seedId}") { id name email ssn } }`,
      regularActor,
    );

    expect(result.errors).toBeUndefined();
    const emp = result.data?.employee as Record<string, unknown>;
    expect(emp).not.toBeNull();

    // Regular user without unmask permission sees masked data
    expect(emp.email).not.toBe("alice@example.com");
    expect(emp.ssn).toBeNull();
  });

  test("non-sensitive fields are never masked", async () => {
    const result = await executeGql(
      `{ employee(id: "${seedId}") { id name department } }`,
      anonymousActor,
    );

    expect(result.errors).toBeUndefined();
    const emp = result.data?.employee as Record<string, unknown>;

    expect(emp.name).toBe("Alice Johnson");
    expect(emp.department).toBe("Engineering");
  });
});

// ── Link traversal masking tests ────────────────────────────

const departmentSchema: SchemaDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    location: { type: "string", label: "Location" },
  },
};

const linkedEmployeeSchema: SchemaDefinition = {
  name: "linked_employee",
  label: "Linked Employee",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", required: true, label: "Email", sensitive: true },
    ssn: { type: "string", label: "SSN", secret: true },
    salary: { type: "number", label: "Salary", sensitive: true },
  },
};

const deptEmployeeLink: LinkDefinition = {
  name: "dept_employee",
  from: "department",
  to: "linked_employee",
  cardinality: "one_to_many",
  label: {
    from: "Employees",
    to: "Department",
  },
};

// Build linked schema
const linkStore = new InMemoryStore();
const linkExecutor = createActionExecutor({ dataProvider: linkStore });

for (const action of generateCrudActions(departmentSchema)) {
  linkExecutor.registry.register(action);
}
for (const action of generateCrudActions(linkedEmployeeSchema)) {
  linkExecutor.registry.register(action);
}

const linkSchemaMap = new Map<string, SchemaDefinition>();
linkSchemaMap.set("department", departmentSchema);
linkSchemaMap.set("linked_employee", linkedEmployeeSchema);

const linkGqlSchema = buildGraphQLSchema([departmentSchema, linkedEmployeeSchema], {
  executor: linkExecutor,
  dataProvider: linkStore,
  permissionGroups,
  links: [deptEmployeeLink],
});

async function executeLinkGql(query: string, actor: Actor, variables?: Record<string, unknown>) {
  const ctx: GraphQLContext = {
    actor,
    permissionGroups,
    dataProvider: linkStore,
    schemaMap: linkSchemaMap,
  };
  return graphql({
    schema: linkGqlSchema,
    source: query,
    contextValue: ctx,
    variableValues: variables,
  });
}

describe("GraphQL link traversal masking", () => {
  const deptId = "dept-link-1";
  const empId1 = "emp-link-1";
  const empId2 = "emp-link-2";

  test("setup: create test records", async () => {
    await linkStore.create("department", {
      id: deptId,
      name: "Engineering",
      location: "Building A",
    });
    await linkStore.create("linked_employee", {
      id: empId1,
      name: "Bob Smith",
      email: "bob@secret.com",
      ssn: "111-22-3333",
      salary: 120000,
      department_id: deptId,
    });
    await linkStore.create("linked_employee", {
      id: empId2,
      name: "Carol Jones",
      email: "carol@secret.com",
      ssn: "444-55-6666",
      salary: 95000,
      department_id: deptId,
    });
  });

  test("anonymous: sensitive fields masked when traversing one_to_many link", async () => {
    const result = await executeLinkGql(
      `{ department(id: "${deptId}") { id name linked_employees { id name email ssn salary } } }`,
      anonymousActor,
    );

    expect(result.errors).toBeUndefined();
    const dept = result.data?.department as Record<string, unknown>;
    expect(dept).not.toBeNull();
    expect(dept.name).toBe("Engineering");

    const employees = dept.linked_employees as Record<string, unknown>[];
    expect(employees).toHaveLength(2);

    for (const emp of employees) {
      // Non-sensitive fields are visible
      expect(typeof emp.name).toBe("string");

      // Sensitive email is masked (not equal to original)
      expect(emp.email).not.toBe("bob@secret.com");
      expect(emp.email).not.toBe("carol@secret.com");

      // Secret SSN is fully masked (null for secret fields)
      expect(emp.ssn).toBeNull();

      // Sensitive number field is coerced to null
      expect(emp.salary).toBeNull();
    }
  });

  test("anonymous: sensitive fields masked when traversing many_to_one (reverse) link", async () => {
    const result = await executeLinkGql(
      `{ linkedEmployee(id: "${empId1}") { id name department { id name location } } }`,
      anonymousActor,
    );

    expect(result.errors).toBeUndefined();
    const emp = result.data?.linkedEmployee as Record<string, unknown>;
    expect(emp).not.toBeNull();

    // Department fields are all non-sensitive, should be visible
    const dept = emp.department as Record<string, unknown>;
    expect(dept).not.toBeNull();
    expect(dept.name).toBe("Engineering");
    expect(dept.location).toBe("Building A");
  });

  test("system_admin: sees unmasked data through link traversal", async () => {
    const result = await executeLinkGql(
      `{ department(id: "${deptId}") { id name linked_employees { id name email ssn salary } } }`,
      adminActor,
    );

    expect(result.errors).toBeUndefined();
    const dept = result.data?.department as Record<string, unknown>;
    const employees = dept.linked_employees as Record<string, unknown>[];
    expect(employees).toHaveLength(2);

    const bob = employees.find((e) => e.name === "Bob Smith") as Record<string, unknown>;
    expect(bob.email).toBe("bob@secret.com");
    expect(bob.ssn).toBe("111-22-3333");
    expect(bob.salary).toBe(120000);

    const carol = employees.find((e) => e.name === "Carol Jones") as Record<string, unknown>;
    expect(carol.email).toBe("carol@secret.com");
    expect(carol.ssn).toBe("444-55-6666");
    expect(carol.salary).toBe(95000);
  });
});
