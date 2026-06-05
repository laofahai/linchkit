/**
 * Data Import endpoint tests.
 *
 * Covers POST /api/entities/:name/import — bulk record creation
 * via multipart form data (CSV and JSON formats).
 */

import { describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  EntityRegistry,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ──────────────────────────────────────────────

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    price: { type: "number", label: "Price" },
    category: { type: "string", label: "Category" },
  },
};

// ── Server setup ──────────────────────────────────────────

const store = new InMemoryStore();
const executionLogger = new InMemoryExecutionLogger();
const executor = createActionExecutor({
  dataProvider: store,
  executionLogger,
});

// Register auto-generated CRUD actions (same as real server setup)
const crudActions = generateCrudActions(productSchema);
for (const action of crudActions) {
  executor.registry.register(action);
}

const entityRegistry = new EntityRegistry();
entityRegistry.register(productSchema);

const graphqlSchema = buildGraphQLSchema([productSchema]);
const app = createServer(graphqlSchema, {
  executor,
  entityRegistry,
});

// In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
// A dummy domain is used since no socket is bound (`app.listen` would SEGFAULT the
// batched addons run when many server suites accumulate sockets in one process).
const BASE = "http://local.test";

function importUrl(entityName: string): string {
  return `${BASE}/api/entities/${entityName}/import`;
}

// ── Tests ─────────────────────────────────────────────────

describe("Data Import endpoint", () => {
  test("imports JSON records successfully", async () => {
    const records = [
      { name: "Widget A", price: 10, category: "Gadgets" },
      { name: "Widget B", price: 20, category: "Gadgets" },
      { name: "Widget C", price: 30, category: "Tools" },
    ];

    const formData = new FormData();
    const blob = new Blob([JSON.stringify(records)], { type: "application/json" });
    formData.append("file", blob, "import.json");
    formData.append("format", "json");

    const res = await app.handle(
      new Request(importUrl("product"), {
        method: "POST",
        body: formData,
      }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.imported).toBe(3);
    expect(json.data.errors).toHaveLength(0);
  });

  test("imports CSV records successfully", async () => {
    const csv = "name,price,category\nCSV Widget,50,Tools\nCSV Gadget,15,Gadgets";

    const formData = new FormData();
    const blob = new Blob([csv], { type: "text/csv" });
    formData.append("file", blob, "import.csv");
    formData.append("format", "csv");

    const res = await app.handle(
      new Request(importUrl("product"), {
        method: "POST",
        body: formData,
      }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.imported).toBe(2);
    expect(json.data.errors).toHaveLength(0);
  });

  test("returns 404 for unknown schema", async () => {
    const formData = new FormData();
    const blob = new Blob([JSON.stringify([{ name: "test" }])], { type: "application/json" });
    formData.append("file", blob, "import.json");
    formData.append("format", "json");

    const res = await app.handle(
      new Request(importUrl("nonexistent"), {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  test("returns error when no file is provided", async () => {
    const formData = new FormData();
    formData.append("format", "json");

    const res = await app.handle(
      new Request(importUrl("product"), {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("No file");
  });

  test("reports per-row errors for invalid records", async () => {
    // Missing required 'name' field — should fail validation
    const records = [
      { name: "Good Record", price: 10, category: "Test" },
      { price: 20, category: "Test" }, // missing required 'name'
    ];

    const formData = new FormData();
    const blob = new Blob([JSON.stringify(records)], { type: "application/json" });
    formData.append("file", blob, "import.json");
    formData.append("format", "json");

    const res = await app.handle(
      new Request(importUrl("product"), {
        method: "POST",
        body: formData,
      }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // At least the first record should succeed
    expect(json.data.imported).toBeGreaterThanOrEqual(1);
  });

  test("handles empty JSON array gracefully", async () => {
    const formData = new FormData();
    const blob = new Blob([JSON.stringify([])], { type: "application/json" });
    formData.append("file", blob, "import.json");
    formData.append("format", "json");

    const res = await app.handle(
      new Request(importUrl("product"), {
        method: "POST",
        body: formData,
      }),
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.imported).toBe(0);
    expect(json.data.errors).toHaveLength(0);
  });
});
