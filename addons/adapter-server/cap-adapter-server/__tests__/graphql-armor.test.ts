/**
 * GraphQL hardening (security audit) — graphql-armor depth/cost guards.
 *
 * The GraphQL schema is auto-generated from the meta-model with bidirectional
 * relation fields, so `department { purchaseRequests { department { ... } } }`
 * can recurse without bound — a DoS vector. These tests verify that:
 *   1. A query exceeding the configured max depth is REJECTED with a GraphQL
 *      validation error (no data resolution).
 *   2. A normal-depth relation query still SUCCEEDS unaffected.
 *   3. Introspection stays enabled in the test environment (tests depend on it
 *      and `ignoreIntrospection` keeps it exempt from the depth/cost caps).
 *
 * Mirrors the server-construction pattern in e2e-relations.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EntityDefinition, RelationDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema + bidirectional relation (cycle source) ─────────────────

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

// Bidirectional one-to-many: department.purchaseRequests <-> purchase_request.department
const deptPurchaseLink: RelationDefinition = {
  name: "department_purchase_requests",
  from: "department",
  to: "purchase_request",
  cardinality: "one_to_many",
  fromName: "purchase_requests",
  toName: "department",
  label: { from: "Purchase Requests", to: "Department" },
};

// ── Setup ──────────────────────────────────────────────────────────

const PORT = 32177;
const GQL_URL = `http://localhost:${PORT}/graphql`;

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

  app = createServer(graphqlSchema, { dataProvider: store, schemaMap });
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

async function gql(query: string) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json() as Promise<{
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string }>;
  }>;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("GraphQL armor depth limit", () => {
  test("rejects a query that exceeds the max depth (relation cycle)", async () => {
    // Build a deeply-nested bidirectional cycle well past GRAPHQL_MAX_DEPTH (12).
    // Each department→purchaseRequests→department pair adds 2 levels; this
    // query reaches a depth of ~16, exceeding the cap.
    const deepQuery = `
      query {
        department(id: "x") {
          purchaseRequests {
            department {
              purchaseRequests {
                department {
                  purchaseRequests {
                    department {
                      purchaseRequests {
                        department {
                          purchaseRequests {
                            department {
                              purchaseRequests {
                                department {
                                  purchaseRequests {
                                    id
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await gql(deepQuery);
    expect(result.errors).toBeDefined();
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    // armor's max-depth validation rejects before resolution → no data.
    const message = result.errors?.map((e) => e.message).join(" ") ?? "";
    expect(message.toLowerCase()).toContain("depth");
    expect(result.data == null).toBe(true);
  });

  test("allows a normal-depth relation query", async () => {
    await store.create("department", { id: "dept_ok", name: "Ops", code: "OPS" });

    // department → purchaseRequests → department → name is well under the cap.
    const result = await gql(`
      query {
        department(id: "dept_ok") {
          id
          name
          purchaseRequests {
            id
            title
            department {
              id
              name
            }
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const dept = result.data?.department as Record<string, unknown> | null;
    expect(dept?.id).toBe("dept_ok");
    expect(dept?.name).toBe("Ops");
  });

  test("introspection stays enabled in the test environment", async () => {
    // ignoreIntrospection (armor default) keeps the standard introspection
    // query — which is itself deep — exempt from the depth/cost caps, and the
    // non-production env leaves introspection on.
    const result = await gql(`
      query {
        __schema {
          queryType { name }
          types {
            name
            fields {
              name
              type {
                name
                ofType {
                  name
                  ofType {
                    name
                  }
                }
              }
            }
          }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const schema = result.data?.__schema as { queryType: { name: string } } | undefined;
    expect(schema?.queryType.name).toBe("Query");
  });
});
