/**
 * E2E Test: AI endpoints
 *
 * Validates all AI-powered REST endpoints:
 * - POST /api/ai/chat — streaming chat with tools
 * - POST /api/ai/auto-fill — form field suggestions
 * - POST /api/ai/search — natural language to filter condition
 * - POST /api/ai/resolve-intent — natural language to action proposal
 *
 * Tests both with mock AI service and without (graceful degradation).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, AIService, SchemaDefinition } from "@linchkit/core";
import { ActionRegistry, SchemaRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ────────────────────────────────────────────────

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
    assignee: { type: "string", label: "Assignee" },
    due_date: { type: "date", label: "Due Date" },
  },
};

const createTaskAction: ActionDefinition = {
  name: "create_task",
  schema: "task",
  label: "Create Task",
  description: "Create a new project task",
  input: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
    assignee: { type: "string", label: "Assignee" },
  },
  policy: "unrestricted",
};

const graphqlSchema = buildGraphQLSchema([taskSchema]);

// ── Mock AI service ──────────────────────────────────────

const mockAiService: AIService = {
  configured: true,
  defaultProvider: "mock",
  providerNames: ["mock"],
  complete: async (options) => {
    // Concatenate all message contents for routing
    const allText = options.messages.map((m) => m.content).join(" ");

    // Route to different responses based on prompt content
    if (
      allText.includes("auto-fill") ||
      allText.includes("suggest") ||
      allText.includes("Fields that need suggestions")
    ) {
      return {
        content: JSON.stringify({
          title: { value: "Weekly Standup Notes", confidence: 0.85, reason: "Common task title" },
          priority: { value: "medium", confidence: 0.7, reason: "Default priority" },
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: "test-model",
        provider: "test",
        duration: 100,
      };
    }
    if (allText.includes("search filter") || allText.includes("structured filter")) {
      return {
        content: JSON.stringify({
          filter: {
            operator: "and",
            conditions: [
              { field: "priority", operator: "eq", value: "high" },
              { field: "assignee", operator: "eq", value: "Alice" },
            ],
          },
          explanation: "Filter by high priority and assignee Alice",
        }),
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
        model: "test-model",
        provider: "test",
        duration: 80,
      };
    }
    if (
      allText.includes("Intent Resolver") ||
      allText.includes("resolve") ||
      allText.includes("intent")
    ) {
      return {
        content: JSON.stringify({
          action: "create_task",
          schema: "task",
          input: { title: "Setup CI/CD pipeline", priority: "high" },
          missingFields: ["assignee"],
          confidence: 0.9,
          explanation: "I'll create a high-priority task for setting up CI/CD.",
        }),
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        model: "test-model",
        provider: "test",
        duration: 150,
      };
    }
    // Default response
    return {
      content: "I can help you with that!",
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      model: "test-model",
      provider: "test",
      duration: 50,
    };
  },
};

// ══════════════════════════════════════════════════════════
// Section 1: AI Not Configured (graceful degradation)
// ══════════════════════════════════════════════════════════

describe("E2E AI endpoints — no AI service configured", () => {
  const PORT = 32140;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("1. /api/ai/auto-fill returns empty suggestions", async () => {
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

  test("2. /api/ai/search returns null data", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "high priority tasks for Alice",
        schema: "task",
        fields: { priority: { type: "enum", label: "Priority" } },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  test("3. /api/ai/resolve-intent returns null data", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a task for CI/CD setup",
        context: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  test("4. /api/ai/chat returns 503 when not configured", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        context: {},
      }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("not configured");
  });

  test("5. /api/app-config shows aiEnabled=false", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/app-config`);
    const json = await res.json();
    expect(json.data.aiEnabled).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// Section 2: AI Configured (with mock service)
// ══════════════════════════════════════════════════════════

describe("E2E AI endpoints — with mock AI service", () => {
  const PORT = 32141;
  let server: ReturnType<typeof createServer>;

  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createTaskAction);

  const schemaRegistry = new SchemaRegistry();
  schemaRegistry.register(taskSchema);

  const mockExecutor = {
    registry: actionRegistry,
    execute: async () => ({
      success: true,
      data: { id: "test-123" },
      executionId: "exec-test",
    }),
  };

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: mockAiService,
      // biome-ignore lint/suspicious/noExplicitAny: mock for test
      executor: mockExecutor as any,
      schemaRegistry,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("6. /api/ai/auto-fill returns AI-generated suggestions", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          priority: { type: "enum", label: "Priority", options: ["low", "medium", "high"] },
        },
        currentValues: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.suggestions).toBeDefined();
    expect(json.data.suggestions.title).toBeDefined();
    expect(json.data.suggestions.title.value).toBe("Weekly Standup Notes");
    expect(json.data.suggestions.title.confidence).toBe(0.85);
  });

  test("7. /api/ai/auto-fill returns empty when all fields filled", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
        },
        currentValues: { title: "Already Filled" },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.suggestions).toEqual({});
  });

  test("8. /api/ai/auto-fill returns 400 when schema is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentValues: {} }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  test("9. /api/ai/search returns structured filter condition", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "high priority tasks assigned to Alice",
        schema: "task",
        fields: {
          priority: { type: "enum", label: "Priority", options: ["low", "medium", "high"] },
          assignee: { type: "string", label: "Assignee" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeDefined();
    // Should return a structured filter condition with explanation
    expect(json.data.filter).toBeDefined();
    expect(json.data.filter.operator || json.data.filter.field).toBeDefined();
  });

  test("10. /api/ai/search returns 400 when query is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "task" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  test("11. /api/ai/search returns 400 when schema is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "find all tasks" }),
    });

    expect(res.status).toBe(400);
  });

  test("12. /api/ai/resolve-intent resolves natural language to action", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a high priority task for CI/CD pipeline setup",
        context: { schema: "task" },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).not.toBeNull();
    expect(json.data.action).toBe("create_task");
    expect(json.data.schema).toBe("task");
    expect(json.data.confidence).toBeGreaterThan(0.5);
    expect(json.data.explanation).toBeTruthy();
    expect(json.data.actionLabel).toBe("Create Task");
    expect(json.data.inputSchema).toBeDefined();
  });

  test("13. /api/ai/resolve-intent returns 400 when message is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: {} }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("message is required");
  });

  test("14. /api/ai/chat returns 400 when messages array is empty", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [], context: {} }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("messages");
  });

  test("15. /api/app-config shows aiEnabled=true", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/app-config`);
    const json = await res.json();
    expect(json.data.aiEnabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// Section 3: AI with low confidence (edge cases)
// ══════════════════════════════════════════════════════════

describe("E2E AI endpoints — low confidence / edge cases", () => {
  const PORT = 32142;
  let server: ReturnType<typeof createServer>;

  const lowConfService: AIService = {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    complete: async () => ({
      content: JSON.stringify({
        action: null,
        schema: null,
        input: {},
        missingFields: [],
        confidence: 0.1,
        explanation: "Could not understand the request.",
      }),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      model: "test-model",
      provider: "test",
      duration: 100,
    }),
  };

  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createTaskAction);
  const schemaRegistry = new SchemaRegistry();
  schemaRegistry.register(taskSchema);

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: lowConfService,
      executor: {
        registry: actionRegistry,
        execute: async () => ({ success: true, data: {}, executionId: "x" }),
        // biome-ignore lint/suspicious/noExplicitAny: mock for test
      } as any,
      schemaRegistry,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("16. resolve-intent returns null when confidence is too low", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "do something unclear",
        context: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });
});
