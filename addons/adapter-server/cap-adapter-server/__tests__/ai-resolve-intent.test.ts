import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, AIService, EntityDefinition } from "@linchkit/core";
import { ActionRegistry, EntityRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const purchaseSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request",
  fields: {
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", required: true, label: "Department" },
    description: { type: "text", label: "Description" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  },
};

const createPurchaseAction: ActionDefinition = {
  name: "create_purchase_request",
  entity: "purchase_request",
  label: "Create Purchase Request",
  description: "Create a new purchase request for a department",
  input: {
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", required: true, label: "Department" },
    description: { type: "text", label: "Description" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  },
  policy: "unrestricted",
};

const graphqlSchema = buildGraphQLSchema([purchaseSchema]);

// ── No AI service configured ─────────────────────────────

describe("POST /api/ai/resolve-intent — no AI service", () => {
  const PORT = 31910;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns null data when AI is not configured", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a purchase request for 5000",
        context: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  test("returns 400 when message is missing", async () => {
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
});

// ── With mock AI service ─────────────────────────────────

describe("POST /api/ai/resolve-intent — with AI service", () => {
  const PORT = 31911;
  let server: ReturnType<typeof createServer>;

  const mockAiService: AIService = {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    complete: async () => ({
      content: JSON.stringify({
        action: "create_purchase_request",
        schema: "purchase_request",
        input: { amount: 5000, department: "General Admin" },
        missingFields: ["description"],
        confidence: 0.92,
        explanation: "I'll create a purchase request for 5,000 assigned to General Admin.",
      }),
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      model: "test-model",
      provider: "test",
      duration: 150,
    }),
  };

  // Build executor with action registry
  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createPurchaseAction);

  const mockExecutor = {
    registry: actionRegistry,
    execute: async () => ({
      success: true,
      data: { id: "test-123" },
      executionId: "exec-test",
    }),
  };

  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseSchema);

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: mockAiService,
      // biome-ignore lint/suspicious/noExplicitAny: mock executor for test
      executor: mockExecutor as any,
      entityRegistry,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("resolves intent from natural language message", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a purchase request for 5000 for General Admin",
        context: { schema: "purchase_request" },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).not.toBeNull();
    expect(json.data.action).toBe("create_purchase_request");
    expect(json.data.schema).toBe("purchase_request");
    expect(json.data.input.amount).toBe(5000);
    expect(json.data.input.department).toBe("General Admin");
    expect(json.data.confidence).toBe(0.92);
    expect(json.data.explanation).toBeTruthy();
    expect(json.data.actionLabel).toBe("Create Purchase Request");
    expect(json.data.missingFields).toContain("description");
    // Input schema should include field metadata
    expect(json.data.inputSchema).toBeDefined();
    expect(json.data.inputSchema.amount.type).toBe("number");
    expect(json.data.inputSchema.amount.required).toBe(true);
  });

  test("returns null when AI returns low confidence", async () => {
    // Override mock to return low confidence
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

    const server2Port = 31912;
    const server2 = createServer(graphqlSchema, {
      port: server2Port,
      aiService: lowConfService,
      // biome-ignore lint/suspicious/noExplicitAny: mock executor for test
      executor: mockExecutor as any,
      entityRegistry,
    });
    server2.listen(server2Port);

    try {
      const res = await fetch(`http://localhost:${server2Port}/api/ai/resolve-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "something unclear",
          context: {},
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    } finally {
      server2.stop?.();
    }
  });

  test("returns null when no executor registry is available", async () => {
    const server3Port = 31913;
    const server3 = createServer(graphqlSchema, {
      port: server3Port,
      aiService: mockAiService,
      // No executor
    });
    server3.listen(server3Port);

    try {
      const res = await fetch(`http://localhost:${server3Port}/api/ai/resolve-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Create something",
          context: {},
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    } finally {
      server3.stop?.();
    }
  });
});
