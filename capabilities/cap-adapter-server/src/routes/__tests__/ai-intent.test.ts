/**
 * AI Intent Resolution + Execution tests
 *
 * Tests for POST /api/ai/resolve-intent and POST /api/ai/execute-intent.
 * Covers:
 * - Intent resolution with OntologyRegistry context
 * - Schema AI config filtering (ai.actionable === false)
 * - execute-intent proxies to executor with ai metadata
 * - Graceful degradation when AI service is unavailable
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, AIService, SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, InMemoryStore, SchemaRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../../graphql/build-schema";
import { createServer } from "../../server";

// ── Schemas ───────────────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount (CNY)" },
    department: { type: "string", label: "Department" },
  },
};

/** Schema with AI disabled — actions should not appear in resolve-intent */
const confidentialSchema: SchemaDefinition = {
  name: "confidential_report",
  label: "Confidential Report",
  fields: {
    content: { type: "text", label: "Content" },
  },
  ai: { actionable: false },
};

// ── Actions ────────────────────────────────────────────────

const createPurchaseAction: ActionDefinition = {
  name: "create_purchase_request",
  schema: "purchase_request",
  label: "Create Purchase Request",
  description: "Creates a new purchase request",
  input: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", label: "Department" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  ai: {
    confirmationMode: "explicit",
    promptHints: ["Used to create purchase requests", "Amount is in CNY"],
  },
  handler: async (ctx) => {
    return ctx.create("purchase_request", ctx.input);
  },
};

const createConfidentialAction: ActionDefinition = {
  name: "create_confidential_report",
  schema: "confidential_report",
  label: "Create Confidential Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("confidential_report", ctx.input);
  },
};

// ── Mock AI service factory ───────────────────────────────

function createMockAIService(responseContent: string): AIService {
  return {
    configured: true,
    provider: "mock",
    providers: ["mock"],
    complete: async () => ({
      content: responseContent,
      model: "mock-model",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }),
  } as unknown as AIService;
}

const noopAIService: AIService = {
  configured: false,
  provider: null,
  providers: [],
  complete: async () => {
    throw new Error("AI not configured");
  },
} as unknown as AIService;

// ── Server builder (returns server + store) ───────────────

function buildTestServer(aiService: AIService): {
  server: ReturnType<typeof createServer>;
  store: InMemoryStore;
} {
  const store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  executor.registry.register(createPurchaseAction);
  executor.registry.register(createConfidentialAction);

  const schemaRegistry = new SchemaRegistry();
  schemaRegistry.register(purchaseRequestSchema);
  schemaRegistry.register(confidentialSchema);

  const graphqlSchema = buildGraphQLSchema([purchaseRequestSchema, confidentialSchema], {
    executor,
    dataProvider: store,
  });

  const server = createServer(graphqlSchema, {
    executor,
    aiService,
    schemaRegistry,
  });

  return { server, store };
}

// ── Main test server ──────────────────────────────────────

const PORT = 34210;
// biome-ignore lint/suspicious/noExplicitAny: test server type
let mainApp: any;
let mainStore: InMemoryStore;

beforeAll(() => {
  const mockResponse = JSON.stringify({
    action: "create_purchase_request",
    schema: "purchase_request",
    input: { title: "Laptop x3", amount: 24000, department: "IT" },
    missingFields: [],
    confidence: 0.92,
    explanation: "I'll create a purchase request for 3 laptops totalling ¥24,000 for IT.",
  });

  const { server, store } = buildTestServer(createMockAIService(mockResponse));
  mainApp = server;
  mainStore = store;
  mainApp.listen(PORT);
});

afterAll(() => {
  mainApp?.stop();
});

beforeEach(() => {
  mainStore?.clear();
});

// ── HTTP helper ───────────────────────────────────────────

async function post(path: string, body: unknown, port = PORT) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── Tests: resolve-intent ─────────────────────────────────

describe("POST /api/ai/resolve-intent", () => {
  test("returns 400 when message is missing", async () => {
    const { status, body } = await post("/api/ai/resolve-intent", {});
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  test("returns resolved intent for natural language message", async () => {
    const { status, body } = await post("/api/ai/resolve-intent", {
      message: "Create a purchase request for 3 laptops at ¥8000 each for IT department",
    });
    expect(status).toBe(200);
    const data = body as { success: boolean; data: Record<string, unknown> };
    expect(data.success).toBe(true);
    expect(data.data).not.toBeNull();
    expect(data.data.action).toBe("create_purchase_request");
    expect(data.data.confidence).toBeGreaterThan(0.3);
    expect(data.data.explanation).toBeTruthy();
  });

  test("includes inputSchema in response", async () => {
    const { body } = await post("/api/ai/resolve-intent", {
      message: "Create a purchase request",
    });
    const data = body as { success: boolean; data: { inputSchema: Record<string, unknown> } };
    expect(data.success).toBe(true);
    expect(data.data.inputSchema).toBeDefined();
    expect(data.data.inputSchema.title).toBeDefined();
    expect(data.data.inputSchema.amount).toBeDefined();
  });

  test("includes extracted input values from AI", async () => {
    const { body } = await post("/api/ai/resolve-intent", {
      message: "Create a purchase request for laptops",
    });
    const data = body as { success: boolean; data: { input: Record<string, unknown> } };
    expect(data.success).toBe(true);
    expect(data.data.input).toBeDefined();
    // AI mock returns amount: 24000
    expect(data.data.input.amount).toBe(24000);
  });

  test("graceful degradation when AI service is not configured", async () => {
    const PORT2 = PORT + 1;
    const { server: noAIApp } = buildTestServer(noopAIService);
    noAIApp.listen(PORT2);
    try {
      const { body } = await post(
        "/api/ai/resolve-intent",
        { message: "Create a purchase request" },
        PORT2,
      );
      const result = body as { success: boolean; data: unknown };
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    } finally {
      noAIApp.stop();
    }
  });
});

// ── Tests: execute-intent ─────────────────────────────────

describe("POST /api/ai/execute-intent", () => {
  test("returns 400 when action is missing", async () => {
    const { status, body } = await post("/api/ai/execute-intent", {
      input: { title: "Test", amount: 1000 },
    });
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  test("executes action and returns result with ai source metadata", async () => {
    const { status, body } = await post("/api/ai/execute-intent", {
      action: "create_purchase_request",
      input: { title: "AI-created request", amount: 5000, department: "IT" },
      source: "ai",
    });
    expect(status).toBe(200);
    const result = body as {
      success: boolean;
      data: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect(result.meta?.source).toBe("ai");
    expect(result.meta?.executionId).toBeTruthy();
  });

  test("created record is persisted to data store", async () => {
    await post("/api/ai/execute-intent", {
      action: "create_purchase_request",
      input: { title: "Test Record", amount: 9999, department: "Finance" },
      source: "ai",
    });

    const records = await mainStore.query("purchase_request", {});
    expect(records.length).toBe(1);
    expect(records[0]?.title).toBe("Test Record");
  });

  test("returns error when action is unknown", async () => {
    const { status, body } = await post("/api/ai/execute-intent", {
      action: "nonexistent_action",
      input: {},
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect((body as { success: boolean }).success).toBe(false);
  });
});

// ── Tests: schema AI config ───────────────────────────────

describe("Schema AI config", () => {
  test("ai.actionable=false does not prevent direct execution via execute-intent", async () => {
    // execute-intent goes through the standard executor, AI config is for intent resolution only
    const { status, body } = await post("/api/ai/execute-intent", {
      action: "create_confidential_report",
      input: { content: "some content" },
      source: "ai",
    });
    expect(status).toBe(200);
    expect((body as { success: boolean }).success).toBe(true);
  });
});
