import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AIService, SchemaDefinition } from "@linchkit/core";
import { SchemaRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const productSchema: SchemaDefinition = {
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

const schemaRegistry = new SchemaRegistry();
schemaRegistry.register(productSchema);

// ── No AI configured ─────────────────────────────────────

describe("POST /api/ai/chat — no AI configured", () => {
  const PORT = 31920;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns 503 when AI is not configured", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("not configured");
  });

  test("returns 400 when messages array is empty", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("messages");
  });

  test("returns 400 when messages is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});

// ── With AI configured but missing aiConfig ──────────────

describe("POST /api/ai/chat — AI service but no aiConfig", () => {
  const PORT = 31921;
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
      port: PORT,
      aiService: mockAiService,
      schemaRegistry,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns 503 when aiConfig is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Chat endpoint checks both aiService?.configured AND aiConfig
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});

// ── Message format validation ────────────────────────────

describe("POST /api/ai/chat — message validation", () => {
  const PORT = 31922;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns 400 when messages is not an array", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: "not an array" }),
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 when body is null/empty", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    });

    // Should get 400 since messages is missing
    expect(res.status).toBe(400);
  });
});
