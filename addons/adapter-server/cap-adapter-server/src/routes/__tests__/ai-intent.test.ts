/**
 * AI Intent Resolution + Execution tests
 *
 * Tests for POST /api/ai/resolve-intent and POST /api/ai/execute-intent.
 * Covers:
 * - Intent resolution against the canonical resolver (Spec 52 §2.6 contract:
 *   `{ prompt, scope }` request, `{ proposal: ActionProposal | null }` response).
 * - Schema AI config filtering — Phase 0 PoC scope: see ai-resolve-intent.test.ts
 *   for the full permission-scoped catalog tests.
 * - execute-intent proxies to executor with ai metadata.
 * - Graceful degradation when AI service is unavailable (503).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, AIService, EntityDefinition } from "@linchkit/core";
import {
  ActionRegistry,
  createActionExecutor,
  createOntologyRegistry,
  EntityRegistry,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../../graphql/build-schema";
import { createServer } from "../../server";
import { enrichProposal } from "../ai-resolve-intent";

// ── Schemas ───────────────────────────────────────────────

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount (CNY)" },
    department: { type: "string", label: "Department" },
  },
};

/** Schema with AI disabled — actions should not appear in resolve-intent */
const confidentialSchema: EntityDefinition = {
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
  entity: "purchase_request",
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
  entity: "confidential_report",
  label: "Create Confidential Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("confidential_report", ctx.input);
  },
};

/** Second purchase-request action — used as an alternative target in tests. */
const updatePurchaseAction: ActionDefinition = {
  name: "update_purchase_request",
  entity: "purchase_request",
  label: "Update Purchase Request",
  description: "Updates an existing purchase request",
  input: {
    id: { type: "string", required: true, label: "Request ID" },
    title: { type: "string", label: "Title" },
    amount: { type: "number", label: "Amount" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id, ...rest } = ctx.input as { id: string; [k: string]: unknown };
    return ctx.update("purchase_request", id, rest);
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
  executor.registry.register(updatePurchaseAction);

  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseRequestSchema);
  entityRegistry.register(confidentialSchema);

  // Build an ontology so the canonical resolver has a catalog to scan.
  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createPurchaseAction);
  actionRegistry.register(createConfidentialAction);
  actionRegistry.register(updatePurchaseAction);
  const ontology = createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules: [],
    states: [],
    views: [],
  });

  const graphqlSchema = buildGraphQLSchema([purchaseRequestSchema, confidentialSchema], {
    executor,
    dataProvider: store,
  });

  const server = createServer(graphqlSchema, {
    executor,
    aiService,
    entityRegistry,
    ontologyRegistry: ontology,
  });

  return { server, store };
}

// ── Main test server ──────────────────────────────────────

const PORT = 34210;
// biome-ignore lint/suspicious/noExplicitAny: test server type
let mainApp: any;
let mainStore: InMemoryStore;

beforeAll(() => {
  // Canonical AI response shape consumed by `resolveIntent()` —
  // see `intent-resolver.ts` aiResponseSchema. `entity` / `missingFields`
  // are NOT part of the resolver's contract; they're derived server-side.
  const mockResponse = JSON.stringify({
    action: "create_purchase_request",
    input: { title: "Laptop x3", amount: 24000, department: "IT" },
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

// ── Tests: resolve-intent (Spec 52 §2.6 contract) ─────────

describe("POST /api/ai/resolve-intent", () => {
  test("returns 400 when prompt is missing", async () => {
    const { status, body } = await post("/api/ai/resolve-intent", {});
    expect(status).toBe(400);
    expect((body as { success: boolean }).success).toBe(false);
  });

  test("returns ActionProposal for a natural-language prompt", async () => {
    const { status, body } = await post("/api/ai/resolve-intent", {
      prompt: "Create a purchase request for 3 laptops at ¥8000 each for IT department",
    });
    expect(status).toBe(200);
    const data = body as {
      proposal: { action: string; confidence: number; explanation: string } | null;
    };
    expect(data.proposal).not.toBeNull();
    if (!data.proposal) throw new Error("expected proposal");
    expect(data.proposal.action).toBe("create_purchase_request");
    expect(data.proposal.confidence).toBeGreaterThan(0.3);
    expect(data.proposal.explanation.length).toBeGreaterThan(0);
  });

  test("includes extracted input values from AI", async () => {
    const { body } = await post("/api/ai/resolve-intent", {
      prompt: "Create a purchase request for laptops",
    });
    const data = body as { proposal: { input: Record<string, unknown> } | null };
    expect(data.proposal).not.toBeNull();
    if (!data.proposal) throw new Error("expected proposal");
    // AI mock returns amount: 24000
    expect(data.proposal.input.amount).toBe(24000);
  });

  test("returns 503 when AI service is not configured", async () => {
    const PORT2 = PORT + 1;
    const { server: noAIApp } = buildTestServer(noopAIService);
    noAIApp.listen(PORT2);
    try {
      const { status, body } = await post(
        "/api/ai/resolve-intent",
        { prompt: "Create a purchase request" },
        PORT2,
      );
      expect(status).toBe(503);
      const result = body as { success: boolean; error: { message: string } };
      expect(result.success).toBe(false);
      expect(result.error.message.length).toBeGreaterThan(0);
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

// ── Tests: alternatives enrichment (issue #78 follow-up) ─────

/**
 * Wire-format envelope assertions for alternatives carried alongside the
 * primary proposal. The route enriches alternatives with the same display
 * metadata as the primary so the UI can swap one into the primary slot
 * without a second round-trip.
 */

interface EnrichedAlternative {
  action: string;
  input: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
  explanation: string;
  schema: string;
  actionLabel: string;
  actionDescription?: string;
  inputSchema: Record<string, { type: string; required: boolean; label?: string }>;
}

interface EnrichedProposal {
  action: string;
  schema: string;
  actionLabel: string;
  actionDescription?: string;
  inputSchema: Record<string, unknown>;
  confidence: number;
  alternatives?: EnrichedAlternative[];
}

describe("POST /api/ai/resolve-intent — alternatives enrichment", () => {
  /**
   * Build a port-isolated server whose mock AI returns the given JSON string.
   * Mirrors the inline server pattern used by the 503 test above.
   */
  function buildServerWithMock(port: number, mockJson: string) {
    const { server } = buildTestServer(createMockAIService(mockJson));
    server.listen(port);
    return server;
  }

  test("alternative with valid scoped action is enriched with full display metadata", async () => {
    const PORT3 = PORT + 10;
    const mock = JSON.stringify({
      // Primary confidence below ALTERNATIVES_CONFIDENCE_THRESHOLD (0.7) so
      // the resolver actually surfaces alternatives.
      action: "create_purchase_request",
      input: { title: "Laptops", amount: 5000 },
      confidence: 0.55,
      explanation: "Maybe create a purchase request.",
      alternatives: [
        {
          action: "update_purchase_request",
          input: { id: "PR-1", amount: 5000 },
          confidence: 0.5,
          explanation: "Or update the existing one.",
        },
      ],
    });
    const app = buildServerWithMock(PORT3, mock);
    try {
      const { status, body } = await post(
        "/api/ai/resolve-intent",
        { prompt: "Order laptops" },
        PORT3,
      );
      expect(status).toBe(200);
      const proposal = (body as { proposal: EnrichedProposal | null }).proposal;
      if (!proposal) throw new Error("expected proposal");
      expect(proposal.alternatives).toBeDefined();
      const alternatives = proposal.alternatives ?? [];
      expect(alternatives.length).toBe(1);

      const alt = alternatives[0];
      if (!alt) throw new Error("expected alternative");
      expect(alt.action).toBe("update_purchase_request");
      // Display metadata mirrors the primary's enrichment shape.
      expect(alt.schema).toBe("purchase_request");
      expect(alt.actionLabel).toBe("Update Purchase Request");
      expect(alt.actionDescription).toBe("Updates an existing purchase request");
      expect(alt.inputSchema).toBeDefined();
      // Input schema should reflect the action's defined fields (id required).
      expect(alt.inputSchema.id?.required).toBe(true);
      expect(alt.inputSchema.id?.type).toBe("string");
    } finally {
      app.stop();
    }
  });

  test("alternatives are sorted DESC by confidence after enrichment", async () => {
    const PORT3 = PORT + 11;
    // AI returns alternatives in scrambled order; the route must hand back a
    // confidence-DESC list. The resolver itself already sorts but filtering
    // could shift positions, so the route's defensive resort matters.
    const mock = JSON.stringify({
      action: "create_purchase_request",
      input: {},
      confidence: 0.5,
      explanation: "Low-confidence primary.",
      alternatives: [
        {
          action: "update_purchase_request",
          input: { id: "PR-1" },
          confidence: 0.45,
          explanation: "lower",
        },
        {
          action: "create_confidential_report",
          input: {},
          confidence: 0.6,
          explanation: "higher",
        },
      ],
    });
    const app = buildServerWithMock(PORT3, mock);
    try {
      const { body } = await post("/api/ai/resolve-intent", { prompt: "ambiguous" }, PORT3);
      const proposal = (body as { proposal: EnrichedProposal | null }).proposal;
      if (!proposal) throw new Error("expected proposal");
      const alternatives = proposal.alternatives ?? [];
      // Both alternative actions are in the scoped ontology so both survive.
      expect(alternatives.length).toBe(2);
      // DESC by confidence — the higher-confidence one comes first.
      expect(alternatives[0]?.confidence).toBeGreaterThanOrEqual(alternatives[1]?.confidence ?? 0);
    } finally {
      app.stop();
    }
  });

  test("alternatives field is omitted when the resolver returns none", async () => {
    // Primary at high confidence (>= 0.7) — resolver does not surface
    // alternatives. The wire envelope must omit the field entirely (not
    // emit `alternatives: []`), matching the resolver's own "omit when
    // empty" convention.
    const { body } = await post("/api/ai/resolve-intent", {
      prompt: "Create a purchase request for laptops",
    });
    const proposal = (body as { proposal: EnrichedProposal | null }).proposal;
    if (!proposal) throw new Error("expected proposal");
    expect("alternatives" in proposal).toBe(false);
  });

  test("hallucination defense: alternative whose action is not in the scoped ontology is dropped", () => {
    // Unit-level test for the route's enrichProposal exit gate. The resolver
    // also filters unknown alternatives, so this is defense-in-depth — but
    // we want the route to NEVER echo a half-enriched alternative whose
    // action the user can't see (same rule as the primary).
    const purchaseAction: ActionDefinition = createPurchaseAction;
    const updateAction: ActionDefinition = updatePurchaseAction;
    const ontology = {
      listEntities: () => ["purchase_request"],
      actionsFor: (entity: string) =>
        entity === "purchase_request" ? [purchaseAction, updateAction] : [],
    };

    const enriched = enrichProposal(
      {
        action: "create_purchase_request",
        input: {},
        confidence: 0.5,
        missingFields: [],
        explanation: "primary",
        alternatives: [
          {
            action: "update_purchase_request",
            input: {},
            confidence: 0.45,
            missingFields: [],
            explanation: "valid alt",
          },
          {
            action: "delete_everything", // not in the scoped ontology
            input: {},
            confidence: 0.49,
            missingFields: [],
            explanation: "hallucinated",
          },
        ],
      },
      ontology,
    );
    if (!enriched) throw new Error("expected enriched proposal");
    expect(enriched.alternatives).toBeDefined();
    expect(enriched.alternatives?.length).toBe(1);
    expect(enriched.alternatives?.[0]?.action).toBe("update_purchase_request");
  });

  test("hallucination defense: alternatives field is omitted when filtering drops every entry", () => {
    const purchaseAction: ActionDefinition = createPurchaseAction;
    const ontology = {
      listEntities: () => ["purchase_request"],
      actionsFor: (entity: string) => (entity === "purchase_request" ? [purchaseAction] : []),
    };

    const enriched = enrichProposal(
      {
        action: "create_purchase_request",
        input: {},
        confidence: 0.5,
        missingFields: [],
        explanation: "primary",
        alternatives: [
          {
            action: "ghost_action",
            input: {},
            confidence: 0.45,
            missingFields: [],
            explanation: "all hallucinated",
          },
        ],
      },
      ontology,
    );
    if (!enriched) throw new Error("expected enriched proposal");
    // No usable alternatives → field is omitted (matches the resolver's
    // existing "omit when empty" convention).
    expect("alternatives" in enriched).toBe(false);
  });

  test("empty alternatives input produces no alternatives field on the wire", () => {
    const purchaseAction: ActionDefinition = createPurchaseAction;
    const ontology = {
      listEntities: () => ["purchase_request"],
      actionsFor: (entity: string) => (entity === "purchase_request" ? [purchaseAction] : []),
    };

    const enriched = enrichProposal(
      {
        action: "create_purchase_request",
        input: {},
        confidence: 0.92,
        missingFields: [],
        explanation: "primary",
        // alternatives intentionally absent — primary above threshold.
      },
      ontology,
    );
    if (!enriched) throw new Error("expected enriched proposal");
    expect("alternatives" in enriched).toBe(false);
  });
});
