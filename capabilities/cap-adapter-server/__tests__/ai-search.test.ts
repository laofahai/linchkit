import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AIService, SchemaDefinition } from "@linchkit/core";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const orderSchema: SchemaDefinition = {
  name: "order",
  label: "Order",
  description: "A sales order",
  fields: {
    customer_name: { type: "string", required: true, label: "Customer Name" },
    amount: { type: "number", required: true, label: "Amount" },
    status: {
      type: "enum",
      label: "Status",
      options: [{ value: "draft" }, { value: "confirmed" }, { value: "shipped" }, { value: "delivered" }],
    },
    created_at: { type: "datetime", label: "Created At" },
    notes: { type: "text", label: "Notes" },
  },
};

const graphqlSchema = buildGraphQLSchema([orderSchema]);

// ── No AI configured ─────────────────────────────────────

describe("POST /api/ai/search — no AI configured", () => {
  const PORT = 31930;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns null data when AI is not configured", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "orders over 1000",
        schema: "order",
        fields: { amount: { type: "number", label: "Amount" } },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  test("returns 400 when query is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "order" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("query");
  });

  test("returns 400 when schema is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "find something" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("schema");
  });
});

// ── With mock AI service ─────────────────────────────────

describe("POST /api/ai/search — with AI service", () => {
  const PORT = 31931;
  let server: ReturnType<typeof createServer>;

  const mockAiService: AIService = {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    complete: async () => ({
      content: JSON.stringify({
        filter: {
          field: "amount",
          operator: "gt",
          value: 1000,
        },
        explanation: "Orders where amount is greater than 1000",
      }),
      usage: { inputTokens: 150, outputTokens: 80, totalTokens: 230 },
      model: "test-model",
      provider: "test",
      duration: 120,
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

  test("returns filter condition from AI", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "orders over 1000",
        schema: "order",
        fields: {
          amount: { type: "number", label: "Amount" },
          status: { type: "enum", label: "Status", options: ["draft", "confirmed"] },
        },
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).not.toBeNull();
    expect(json.data.filter.field).toBe("amount");
    expect(json.data.filter.operator).toBe("gt");
    expect(json.data.filter.value).toBe(1000);
    expect(json.data.explanation).toContain("1000");
  });

  test("returns composite AND filter", async () => {
    const compositeAiService: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async () => ({
        content: JSON.stringify({
          filter: {
            operator: "and",
            conditions: [
              { field: "amount", operator: "gt", value: 500 },
              { field: "status", operator: "eq", value: "confirmed" },
            ],
          },
          explanation: "Confirmed orders over 500",
        }),
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        model: "test-model",
        provider: "test",
        duration: 130,
      }),
    };

    const PORT2 = 31932;
    const srv = createServer(graphqlSchema, {
      port: PORT2,
      aiService: compositeAiService,
    });
    srv.listen(PORT2);

    try {
      const res = await fetch(`http://localhost:${PORT2}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "confirmed orders over 500",
          schema: "order",
          fields: {
            amount: { type: "number", label: "Amount" },
            status: { type: "enum", label: "Status" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.filter.operator).toBe("and");
      expect(json.data.filter.conditions).toHaveLength(2);
    } finally {
      srv.stop?.();
    }
  });
});

// ── Filter validation — field whitelisting ────────────────

describe("POST /api/ai/search — filter validation", () => {
  test("strips fields not in the schema", async () => {
    const PORT = 31933;
    const badFieldAiService: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async () => ({
        content: JSON.stringify({
          filter: {
            operator: "and",
            conditions: [
              { field: "amount", operator: "gt", value: 100 },
              { field: "nonexistent_field", operator: "eq", value: "hack" },
            ],
          },
          explanation: "test",
        }),
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
        model: "test-model",
        provider: "test",
        duration: 50,
      }),
    };

    const srv = createServer(graphqlSchema, {
      port: PORT,
      aiService: badFieldAiService,
    });
    srv.listen(PORT);

    try {
      const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "hacked query",
          schema: "order",
          fields: {
            amount: { type: "number", label: "Amount" },
            status: { type: "enum", label: "Status" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      // The invalid field should be stripped; only `amount` remains
      const filter = json.data.filter;
      // After stripping, the AND with one condition reduces to just the single condition
      expect(filter.field).toBe("amount");
    } finally {
      srv.stop?.();
    }
  });

  test("strips sensitive fields (password, tenant_id)", async () => {
    const PORT = 31934;
    const sensitiveFieldAiService: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async () => ({
        content: JSON.stringify({
          filter: {
            field: "tenant_id",
            operator: "eq",
            value: "stolen-tenant",
          },
          explanation: "Trying to access another tenant",
        }),
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
        model: "test-model",
        provider: "test",
        duration: 50,
      }),
    };

    const srv = createServer(graphqlSchema, {
      port: PORT,
      aiService: sensitiveFieldAiService,
    });
    srv.listen(PORT);

    try {
      const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "all records from tenant X",
          schema: "order",
          fields: {
            amount: { type: "number", label: "Amount" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      // tenant_id is a sensitive field and should be stripped
      // The filter is validated server-side: stripped field → null filter
      // But the endpoint wraps it in { filter, explanation }, so data.filter is null
      expect(json.success).toBe(true);
      expect(json.data.filter).toBeNull();
    } finally {
      srv.stop?.();
    }
  });

  test("returns null when AI returns null filter", async () => {
    const PORT = 31935;
    const nullFilterAi: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async () => ({
        content: JSON.stringify({
          filter: null,
          explanation: "Could not parse the query into a filter",
        }),
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
        model: "test-model",
        provider: "test",
        duration: 40,
      }),
    };

    const srv = createServer(graphqlSchema, { port: PORT, aiService: nullFilterAi });
    srv.listen(PORT);

    try {
      const res = await fetch(`http://localhost:${PORT}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "something unparseable",
          schema: "order",
          fields: { amount: { type: "number" } },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    } finally {
      srv.stop?.();
    }
  });
});

// ── Query sanitization (prompt injection defense) ────────

describe("POST /api/ai/search — query sanitization", () => {
  test("sanitizes control characters from query", async () => {
    const PORT = 31936;
    let capturedPrompt = "";
    const spyAiService: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async (opts) => {
        // Capture the user message to verify sanitization
        capturedPrompt = opts.messages.find((m) => m.role === "user")?.content ?? "";
        return {
          content: JSON.stringify({ filter: null, explanation: "ok" }),
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
          model: "test-model",
          provider: "test",
          duration: 40,
        };
      },
    };

    const srv = createServer(graphqlSchema, { port: PORT, aiService: spyAiService });
    srv.listen(PORT);

    try {
      await fetch(`http://localhost:${PORT}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "orders\x00\x01\x02 with amount > 100",
          schema: "order",
          fields: { amount: { type: "number" } },
        }),
      });

      // Control characters should be stripped from the query before passing to AI
      expect(capturedPrompt).not.toContain("\x00");
      expect(capturedPrompt).not.toContain("\x01");
      expect(capturedPrompt).toContain("orders");
      expect(capturedPrompt).toContain("100");
    } finally {
      srv.stop?.();
    }
  });

  test("truncates excessively long queries", async () => {
    const PORT = 31937;
    let capturedPrompt = "";
    const spyAiService: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async (opts) => {
        capturedPrompt = opts.messages.find((m) => m.role === "user")?.content ?? "";
        return {
          content: JSON.stringify({ filter: null, explanation: "ok" }),
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
          model: "test-model",
          provider: "test",
          duration: 40,
        };
      },
    };

    const srv = createServer(graphqlSchema, { port: PORT, aiService: spyAiService });
    srv.listen(PORT);

    try {
      const longQuery = "a".repeat(1000);
      await fetch(`http://localhost:${PORT}/api/ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: longQuery,
          schema: "order",
          fields: { amount: { type: "number" } },
        }),
      });

      // The raw query in the prompt should be truncated to 500 chars
      // (the prompt wraps it in quotes, so we check the sanitized content inside)
      expect(capturedPrompt).not.toContain("a".repeat(501));
    } finally {
      srv.stop?.();
    }
  });
});
