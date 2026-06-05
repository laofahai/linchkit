import { beforeAll, describe, expect, test } from "bun:test";
import type { AIService, EntityDefinition } from "@linchkit/core";
import { EntityRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  description: "A product in inventory",
  fields: {
    name: { type: "string", required: true, label: "Product Name" },
    price: { type: "number", required: true, label: "Price" },
    category: {
      type: "enum",
      label: "Category",
      options: [{ value: "electronics" }, { value: "clothing" }, { value: "food" }],
    },
    description: { type: "text", label: "Description" },
  },
};

const graphqlSchema = buildGraphQLSchema([productSchema]);

const entityRegistry = new EntityRegistry();
entityRegistry.register(productSchema);

// In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
// A dummy domain is used since no socket is bound (`app.listen` would SEGFAULT the
// batched addons run when many server suites accumulate sockets in one process).
const BASE = "http://local.test";

// ── No AI configured ─────────────────────────────────────

describe("POST /api/ai/chat — no AI configured", () => {
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema);
  });

  test("returns 503 when AI is not configured", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
    );

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("not configured");
  });

  test("returns 400 when messages array is empty", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("messages");
  });

  test("returns 400 when messages is missing", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});

// ── With AI configured but missing aiConfig ──────────────

describe("POST /api/ai/chat — AI service but no aiConfig", () => {
  let server: ReturnType<typeof createServer>;

  const mockAiService: AIService = {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    complete: async () => ({
      content: "Hello!",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "test-model",
      provider: "test",
      duration: 50,
    }),
  };

  beforeAll(() => {
    // aiService is set but aiConfig is NOT — chat endpoint requires both
    server = createServer(graphqlSchema, {
      aiService: mockAiService,
      entityRegistry,
    });
  });

  test("returns 503 when aiConfig is missing", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
    );

    // Chat endpoint checks both aiService?.configured AND aiConfig
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});

// ── Message format validation ────────────────────────────

describe("POST /api/ai/chat — message validation", () => {
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema);
  });

  test("returns 400 when messages is not an array", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: "not an array" }),
      }),
    );

    expect(res.status).toBe(400);
  });

  test("returns 400 when body is null/empty", async () => {
    const res = await server.handle(
      new Request(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(null),
      }),
    );

    // Should get 400 since messages is missing
    expect(res.status).toBe(400);
  });
});
