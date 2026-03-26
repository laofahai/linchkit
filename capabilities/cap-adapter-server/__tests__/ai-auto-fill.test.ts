import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AIService, DataProvider, SchemaDefinition } from "@linchkit/core";
import { createSchemaRegistry, InMemoryStore } from "@linchkit/core/server";
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
    amount: { type: "number", label: "Amount", min: 0, max: 10000 },
    department_id: { type: "ref", label: "Department", target: "department" },
  },
};

const departmentSchema: SchemaDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", label: "Name" },
    manager: { type: "string", label: "Manager" },
  },
};

const graphqlSchema = buildGraphQLSchema([taskSchema]);

// Helper to create a data provider with seeded data
async function createSeededDataProvider(): Promise<DataProvider> {
  const store = new InMemoryStore();
  // Seed department
  await store.create("department", {
    id: "dept-1",
    name: "Engineering",
    manager: "Alice",
  });
  // Seed recent tasks with patterns
  for (let i = 0; i < 8; i++) {
    await store.create("task", {
      id: `task-${i}`,
      title: i < 6 ? "Weekly Report" : `Task ${i}`,
      priority: i < 5 ? "medium" : "high",
      amount: 1000 + i * 100,
      department_id: "dept-1",
    });
  }
  return store;
}

function createSchemaReg() {
  const reg = createSchemaRegistry();
  reg.register(taskSchema);
  reg.register(departmentSchema);
  return reg;
}

// ── No AI service, no data ──────────────────────────────

describe("POST /api/ai/auto-fill — no AI, no data", () => {
  const PORT = 31900;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, { port: PORT });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns empty suggestions when no AI and no data", async () => {
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
    // No AI + no data = no suggestions (not random garbage)
    expect(json.data.suggestions).toEqual({});
  });

  test("returns 400 when schema is missing (required field validation before AI check)", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentValues: {} }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("Missing");
  });
});

// ── No AI service, WITH data — statistical fallback ─────

describe("POST /api/ai/auto-fill — no AI, with data (statistical fallback)", () => {
  const PORT = 31904;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const dataProvider = await createSeededDataProvider();
    const schemaRegistry = createSchemaReg();
    server = createServer(graphqlSchema, {
      port: PORT,
      dataProvider,
      schemaRegistry,
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns statistical suggestions from recent records without AI", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          priority: { type: "enum", label: "Priority" },
        },
        currentValues: {},
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // "Weekly Report" appears in 6/8 records = 75% frequency
    expect(json.data.suggestions.title).toBeDefined();
    expect(json.data.suggestions.title.value).toBe("Weekly Report");
    expect(json.data.suggestions.title.confidence).toBeGreaterThanOrEqual(0.3);
    expect(json.data.suggestions.title.reason).toContain("Most common");

    // "medium" appears in 5/8 records = 62.5% frequency
    expect(json.data.suggestions.priority).toBeDefined();
    expect(json.data.suggestions.priority.value).toBe("medium");
  });

  test("does not suggest values with low frequency", async () => {
    const store = new InMemoryStore();
    // All different values — no dominant pattern
    await store.create("task", { id: "t1", title: "A" });
    await store.create("task", { id: "t2", title: "B" });
    await store.create("task", { id: "t3", title: "C" });
    await store.create("task", { id: "t4", title: "D" });

    const PORT2 = 31905;
    const srv = createServer(graphqlSchema, {
      port: PORT2,
      dataProvider: store,
      schemaRegistry: createSchemaReg(),
    });
    srv.listen(PORT2);

    try {
      const res = await fetch(`http://localhost:${PORT2}/api/ai/auto-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "task",
          fields: { title: { type: "string" } },
          currentValues: {},
        }),
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      // Each value appears in 25% of records — below 30% threshold
      expect(json.data.suggestions.title).toBeUndefined();
    } finally {
      srv.stop?.();
    }
  });
});

// ── With mock AI service ─────────────────────────────────

describe("POST /api/ai/auto-fill — with AI service", () => {
  const PORT = 31901;
  let server: ReturnType<typeof createServer>;
  let lastPrompt = "";

  const mockAiService: AIService = {
    configured: true,
    complete: async ({ messages }) => {
      // Capture the prompt for inspection
      lastPrompt = messages.map((m) => m.content).join("\n");
      return {
        content: JSON.stringify({
          title: { value: "Weekly Report", confidence: 0.8, reason: "Common task title" },
          description: { value: "Write the weekly status report", confidence: 0.7, reason: "Inferred from title" },
        }),
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: "test-model",
        provider: "test",
        duration: 100,
      };
    },
  };

  beforeAll(async () => {
    const dataProvider = await createSeededDataProvider();
    const schemaRegistry = createSchemaReg();
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: mockAiService,
      dataProvider,
      schemaRegistry,
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

  test("AI prompt includes data context from recent records", async () => {
    await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          priority: { type: "enum", label: "Priority" },
        },
        currentValues: {},
      }),
    });

    // The prompt should contain data context, not just field names
    expect(lastPrompt).toContain("recent records");
    expect(lastPrompt).toContain("most common");
    expect(lastPrompt).toContain("Weekly Report");
  });

  test("AI prompt includes enum options from schema definition", async () => {
    await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          priority: { type: "enum", label: "Priority" },
        },
        currentValues: {},
      }),
    });

    // Enum options should be explicitly listed in the prompt
    expect(lastPrompt).toContain("MUST be one of");
    expect(lastPrompt).toContain("low");
    expect(lastPrompt).toContain("medium");
    expect(lastPrompt).toContain("high");
  });

  test("AI prompt includes already-filled values as context", async () => {
    await fetch(`http://localhost:${PORT}/api/ai/auto-fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "task",
        fields: {
          title: { type: "string", label: "Title", required: true },
          description: { type: "text", label: "Description" },
        },
        currentValues: { title: "Budget Request" },
      }),
    });

    // Already-filled values should appear in the prompt
    expect(lastPrompt).toContain("Budget Request");
  });

  test("filters out low-confidence AI suggestions", async () => {
    const PORT2 = 31906;
    const lowConfAi: AIService = {
      configured: true,
      complete: async () => ({
        content: JSON.stringify({
          title: { value: "Guess", confidence: 0.2, reason: "random" },
          description: { value: "Good suggestion", confidence: 0.8, reason: "pattern" },
        }),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: "test",
        provider: "test",
        duration: 50,
      }),
    };

    const srv = createServer(graphqlSchema, {
      port: PORT2,
      aiService: lowConfAi,
      schemaRegistry: createSchemaReg(),
    });
    srv.listen(PORT2);

    try {
      const res = await fetch(`http://localhost:${PORT2}/api/ai/auto-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "task",
          fields: {
            title: { type: "string" },
            description: { type: "text" },
          },
          currentValues: {},
        }),
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      // Low-confidence suggestion should be filtered out
      expect(json.data.suggestions.title).toBeUndefined();
      // High-confidence suggestion should pass
      expect(json.data.suggestions.description).toBeDefined();
      expect(json.data.suggestions.description.value).toBe("Good suggestion");
    } finally {
      srv.stop?.();
    }
  });

  test("validates AI-suggested enum values against known options", async () => {
    const PORT2 = 31907;
    const badEnumAi: AIService = {
      configured: true,
      complete: async () => ({
        content: JSON.stringify({
          priority: { value: "critical", confidence: 0.9, reason: "invented option" },
        }),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: "test",
        provider: "test",
        duration: 50,
      }),
    };

    const srv = createServer(graphqlSchema, {
      port: PORT2,
      aiService: badEnumAi,
      schemaRegistry: createSchemaReg(),
    });
    srv.listen(PORT2);

    try {
      const res = await fetch(`http://localhost:${PORT2}/api/ai/auto-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "task",
          fields: {
            priority: { type: "enum", label: "Priority" },
          },
          currentValues: {},
        }),
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      // "critical" is not a valid option — should be rejected
      expect(json.data.suggestions.priority).toBeUndefined();
    } finally {
      srv.stop?.();
    }
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
      configured: true,
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
