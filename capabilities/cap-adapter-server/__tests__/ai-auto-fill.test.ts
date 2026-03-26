import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AIService, SchemaDefinition } from "@linchkit/core";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  description: "A project task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  },
};

const graphqlSchema = buildGraphQLSchema([taskSchema]);

// ── No AI service configured ─────────────────────────────

describe("POST /api/ai/auto-fill — no AI service", () => {
  const PORT = 31900;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns empty suggestions when AI is not configured", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          description: { type: "text", label: "Description" },
        },
        currentValues: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.suggestions).toEqual({});
  });

  test("returns 400 when schema is missing (required field validation before AI check)", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentValues: {} }),
    });

    // Required fields are validated before checking AI availability
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("Missing");
  });
});

// ── With mock AI service ─────────────────────────────────

describe("POST /api/ai/auto-fill — with AI service", () => {
  const PORT = 31901;
  let server: ReturnType<typeof createServer>;

  const mockAiService: AIService = {
    complete: async () => ({
      content: JSON.stringify({
        title: { value: "Weekly Report", confidence: 0.8, reason: "Common task title" },
        description: { value: "Write the weekly status report", confidence: 0.7, reason: "Inferred from title" },
      }),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      model: "test-model",
      provider: "test",
      duration: 100,
    }),
  };

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: mockAiService,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns AI suggestions for empty fields", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          description: { type: "text", label: "Description" },
        },
        currentValues: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.suggestions.title).toBeDefined();
    expect(json.data.suggestions.title.value).toBe("Weekly Report");
    expect(json.data.suggestions.title.confidence).toBe(0.8);
    expect(json.data.suggestions.description.value).toBe("Write the weekly status report");
  });

  test("returns 400 when schema is missing from request body", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentValues: {} }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  test("returns empty suggestions when all fields are filled", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
        },
        currentValues: { title: "Already filled" },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.suggestions).toEqual({});
  });
});

// ── App config aiEnabled ─────────────────────────────────

describe("GET /api/app-config — aiEnabled flag", () => {
  test("aiEnabled is false when no AI service configured", async () => {
    const PORT = 31902;
    const srv = createServer(graphqlSchema, { port: PORT });
    srv.listen(PORT);

    try {
      const res = await fetch(`http://localhost:${PORT}/api/app-config`);
      const json = await res.json();
      expect(json.data.aiEnabled).toBe(false);
    } finally {
      srv.stop?.();
    }
  });

  test("aiEnabled is true when AI service is configured", async () => {
    const PORT = 31903;
    const mockAi: AIService = {
      complete: async () => ({
        content: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "test",
        provider: "test",
        duration: 0,
      }),
    };
    const srv = createServer(graphqlSchema, { port: PORT, aiService: mockAi });
    srv.listen(PORT);

    try {
      const res = await fetch(`http://localhost:${PORT}/api/app-config`);
      const json = await res.json();
      expect(json.data.aiEnabled).toBe(true);
    } finally {
      srv.stop?.();
    }
  });
});
