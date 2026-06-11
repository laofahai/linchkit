/**
 * Integration tests for DerivedPropertyEngine wired into CRUD pipeline and GraphQL resolvers.
 *
 * Verifies:
 * - Store-strategy derived fields are auto-computed on create/update
 * - Compute-strategy derived fields are resolved on read (GraphQL queries)
 */

import { describe, expect, test } from "bun:test";
import { createDerivedPropertyEngine, type EntityDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema with derived fields ──────────────────────────────

const employeeSchema: EntityDefinition = {
  name: "employee",
  label: "Employee",
  fields: {
    first_name: { type: "string", required: true, label: "First Name" },
    last_name: { type: "string", required: true, label: "Last Name" },
    // Store-strategy: auto-computed on write, persisted to DB
    full_name: {
      type: "string",
      label: "Full Name",
      derived: {
        type: "concat",
        fields: ["first_name", "last_name"],
        separator: " ",
        strategy: "store",
      },
    },
    // Compute-strategy: calculated on read, not persisted
    display_label: {
      type: "string",
      label: "Display Label",
      derived: {
        type: "function",
        compute: (rec: Record<string, unknown>) => {
          const first = rec.first_name ?? "";
          const last = rec.last_name ?? "";
          return `[${last}, ${first}]`;
        },
        strategy: "compute",
        deps: ["first_name", "last_name"],
      },
    },
  },
};

const orderSchema: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    price: { type: "number", required: true, label: "Price" },
    quantity: { type: "number", required: true, label: "Quantity" },
    // Store-strategy expression: auto-computed on write
    total: {
      type: "number",
      label: "Total",
      derived: {
        type: "expression",
        expr: "price * quantity",
        strategy: "store",
        deps: ["price", "quantity"],
      },
    },
    // Chained store-strategy: depends on total
    tax: {
      type: "number",
      label: "Tax (10%)",
      derived: {
        type: "expression",
        expr: "total * 0.1",
        strategy: "store",
        deps: ["total"],
      },
    },
  },
};

// ── Setup ────────────────────────────────────────────────────

const store = new InMemoryStore();

// Create and register derived property engine
const derivedEngine = createDerivedPropertyEngine();
derivedEngine.register([employeeSchema, orderSchema]);

const executor = createActionExecutor({ dataProvider: store });

// Register CRUD actions with derived engine wired in
for (const action of generateCrudActions(employeeSchema, {
  derivedPropertyEngine: derivedEngine,
})) {
  executor.registry.register(action);
}
for (const action of generateCrudActions(orderSchema, { derivedPropertyEngine: derivedEngine })) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([employeeSchema, orderSchema], {
  executor,
  dataProvider: store,
  derivedPropertyEngine: derivedEngine,
});
const app = createServer(graphqlSchema);

// In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
// A dummy domain is used since no socket is bound (`app.listen` would SEGFAULT the
// batched addons run when many server suites accumulate sockets in one process).
const BASE = "http://local.test";

// ── Helper ───────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await app.handle(
    new Request(`${BASE}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ────────────────────────────────────────────────────

describe("Derived fields: store-strategy (auto-computed on create)", () => {
  test("concat derived field is computed on create", async () => {
    const result = await gql(`
      mutation {
        createEmployee(input: { first_name: "Jane", last_name: "Doe" }) {
          id
          first_name
          last_name
          full_name
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const emp = result.data.createEmployee as Record<string, unknown>;
    expect(emp.first_name).toBe("Jane");
    expect(emp.last_name).toBe("Doe");
    // Store-strategy concat derived field should be auto-computed
    expect(emp.full_name).toBe("Jane Doe");

    // Verify it's actually persisted in the store
    const stored = await store.get("employee", emp.id as string);
    expect(stored.full_name).toBe("Jane Doe");
  });

  test("expression derived field is computed on create", async () => {
    const result = await gql(`
      mutation {
        createOrder(input: { price: 100, quantity: 3 }) {
          id
          price
          quantity
          total
          tax
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const order = result.data.createOrder as Record<string, unknown>;
    expect(order.price).toBe(100);
    expect(order.quantity).toBe(3);
    expect(order.total).toBe(300);
    // Chained derived field: tax = total * 0.1
    expect(order.tax).toBeCloseTo(30);
  });
});

describe("Derived fields: store-strategy (auto-computed on update)", () => {
  test("concat derived field is recomputed on update", async () => {
    // Create a record first
    const createResult = await gql(`
      mutation {
        createEmployee(input: { first_name: "John", last_name: "Smith" }) {
          id
          full_name
        }
      }
    `);
    const id = (createResult.data.createEmployee as Record<string, unknown>).id as string;

    // Update first_name (must also include last_name since it's required in schema)
    const updateResult = await gql(`
      mutation {
        updateEmployee(id: "${id}", input: { first_name: "Jonathan", last_name: "Smith" }) {
          id
          first_name
          full_name
        }
      }
    `);

    expect(updateResult.errors).toBeUndefined();
    const emp = updateResult.data.updateEmployee as Record<string, unknown>;
    expect(emp.first_name).toBe("Jonathan");
    // Derived field should be recomputed with new first_name + existing last_name
    expect(emp.full_name).toBe("Jonathan Smith");

    // Verify persistence
    const stored = await store.get("employee", id);
    expect(stored.full_name).toBe("Jonathan Smith");
  });

  test("expression derived field is recomputed on update", async () => {
    const createResult = await gql(`
      mutation {
        createOrder(input: { price: 50, quantity: 2 }) {
          id
          total
          tax
        }
      }
    `);
    const id = (createResult.data.createOrder as Record<string, unknown>).id as string;
    expect((createResult.data.createOrder as Record<string, unknown>).total).toBe(100);

    // Update quantity (must also include price since it's required in schema)
    const updateResult = await gql(`
      mutation {
        updateOrder(id: "${id}", input: { price: 50, quantity: 5 }) {
          id
          price
          quantity
          total
          tax
        }
      }
    `);

    expect(updateResult.errors).toBeUndefined();
    const order = updateResult.data.updateOrder as Record<string, unknown>;
    expect(order.quantity).toBe(5);
    expect(order.total).toBe(250); // 50 * 5
    expect(order.tax).toBeCloseTo(25); // 250 * 0.1
  });
});

describe("Derived fields: compute-strategy (resolved on read)", () => {
  test("compute-strategy field is resolved in single record query", async () => {
    // Create a record (compute-strategy fields are NOT stored)
    const createResult = await gql(`
      mutation {
        createEmployee(input: { first_name: "Alice", last_name: "Wonder" }) {
          id
        }
      }
    `);
    const id = (createResult.data.createEmployee as Record<string, unknown>).id as string;

    // Query the record — compute-strategy field should be resolved
    const queryResult = await gql(`
      query {
        employee(id: "${id}") {
          first_name
          last_name
          full_name
          display_label
        }
      }
    `);

    expect(queryResult.errors).toBeUndefined();
    const emp = queryResult.data.employee as Record<string, unknown>;
    expect(emp.full_name).toBe("Alice Wonder"); // store-strategy, persisted
    expect(emp.display_label).toBe("[Wonder, Alice]"); // compute-strategy, resolved on read
  });

  test("compute-strategy fields are resolved in list query", async () => {
    store.clear();
    // Seed records directly (store-strategy fields already computed via CRUD)
    await store.create("employee", {
      id: "list_1",
      first_name: "Bob",
      last_name: "Builder",
      full_name: "Bob Builder",
    });
    await store.create("employee", {
      id: "list_2",
      first_name: "Carol",
      last_name: "Singer",
      full_name: "Carol Singer",
    });

    const result = await gql(`
      query {
        employeeList {
          items {
            id
            display_label
          }
          total
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const listResult = result.data.employeeList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(listResult.items.length).toBe(2);
    // Compute-strategy fields should be resolved for each record
    const labels = listResult.items.map((i) => i.display_label).sort();
    expect(labels).toEqual(["[Builder, Bob]", "[Singer, Carol]"]);
  });
});

describe("Derived fields: no-derived-engine fallback", () => {
  test("CRUD works without derived engine (backward compatibility)", async () => {
    const plainStore = new InMemoryStore();
    const plainExecutor = createActionExecutor({ dataProvider: plainStore });

    // Register CRUD without derived engine
    for (const action of generateCrudActions(employeeSchema)) {
      plainExecutor.registry.register(action);
    }

    const plainSchema = buildGraphQLSchema([employeeSchema], {
      executor: plainExecutor,
      dataProvider: plainStore,
      // No derivedPropertyEngine
    });
    const plainApp = createServer(plainSchema);

    const res = await plainApp.handle(
      new Request(`${BASE}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation { createEmployee(input: { first_name: "Test", last_name: "User" }) { id first_name } }`,
        }),
      }),
    );
    const result = (await res.json()) as { data: Record<string, unknown>; errors?: unknown[] };
    expect(result.errors).toBeUndefined();
    const emp = result.data.createEmployee as Record<string, unknown>;
    expect(emp.first_name).toBe("Test");
    // full_name will be null (not computed since no engine is wired)
    // This is expected backward-compatible behavior
  });
});
