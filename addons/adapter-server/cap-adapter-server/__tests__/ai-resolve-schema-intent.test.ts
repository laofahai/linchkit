/**
 * Spec 52 "说→有" (first slice) — POST /api/ai/resolve-schema-intent
 * integration tests.
 *
 * Exercises the real resolver (resolveSchemaIntent) + a real route-owned
 * ProposalEngine behind the HTTP endpoint, with a deterministic fake
 * AIService (no real LLM calls). Scenarios:
 *   1. Happy path — a draft add_rule Proposal is returned, status `draft`.
 *   2. "Never applies" — the returned proposal status is `draft`, not applied.
 *   3. AI cannot draft a rule → no_match outcome.
 *   4. Empty prompt → 400 (Zod).
 *   5. AI service unavailable → 503 structured error.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActionDefinition, AIService, EntityDefinition } from "@linchkit/core";
import { ActionRegistry, createOntologyRegistry, EntityRegistry } from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Fixtures ─────────────────────────────────────────────────

const purchaseSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request",
  fields: {
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", required: true, label: "Department" },
    status: { type: "string", label: "Status" },
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
  },
  policy: "unrestricted",
};

const graphqlSchema = buildGraphQLSchema([purchaseSchema]);

function buildOntology(): ReturnType<typeof createOntologyRegistry> {
  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseSchema);
  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createPurchaseAction);
  return createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules: [],
    states: [],
    views: [],
  });
}

interface FakeAiServiceOptions {
  responseContent?: string;
  fail?: boolean;
}

function fakeAiService(opts: FakeAiServiceOptions): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async () => {
      if (opts.fail) throw new Error("simulated AI failure");
      return {
        content: opts.responseContent ?? "",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: "fake-model",
        provider: "fake",
        duration: 5,
      };
    },
  } as unknown as AIService;
}

const unconfiguredAi: AIService = {
  configured: false,
  defaultProvider: null,
  providerNames: [],
  complete: async () => {
    throw new Error("AI not configured");
  },
} as unknown as AIService;

async function postSchemaIntent(
  port: number,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://localhost:${port}/api/ai/resolve-schema-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ── Scenario 1+2: Happy path + never applies ─────────────────

describe("POST /api/ai/resolve-schema-intent — happy path", () => {
  const PORT = 31980;
  let server: ReturnType<typeof createServer>;
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      kind: "add_rule",
      targetEntity: "purchase_request",
      rule: {
        name: "block_overlimit_amount",
        label: "Block over-limit amount",
        description: "Block purchase requests over 10000",
        trigger: { action: "create_purchase_request" },
        condition: { field: "amount", operator: "gt", value: 10000 },
        effect: { type: "block", message: "Amount exceeds the 10000 limit" },
      },
      confidence: 0.9,
      explanation: "Block purchase requests whose amount exceeds 10000.",
    }),
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns a draft add_rule Proposal and never applies it", async () => {
    const { status, json } = await postSchemaIntent(PORT, {
      prompt: "Block purchase requests over 10000",
    });
    expect(status).toBe(200);
    const body = json as {
      outcome: string;
      proposal?: {
        type: string;
        status: string;
        diff: { target: string; operation: string; definition: Record<string, unknown> };
      };
      ruleName?: string;
      targetEntity?: string;
    };
    expect(body.outcome).toBe("proposal_draft");
    expect(body.proposal).toBeDefined();
    if (!body.proposal) throw new Error("expected proposal");
    expect(body.proposal.type).toBe("add_rule");
    // The "never applies" guarantee — the route stops at draft.
    expect(body.proposal.status).toBe("draft");
    expect(body.proposal.diff.target).toBe("rule");
    expect(body.proposal.diff.operation).toBe("create");
    expect(body.proposal.diff.definition.name).toBe("block_overlimit_amount");
    expect(body.proposal.diff.definition.condition).toEqual({
      field: "amount",
      operator: "gt",
      value: 10000,
    });
    expect(body.ruleName).toBe("block_overlimit_amount");
    expect(body.targetEntity).toBe("purchase_request");
  });
});

// ── Scenario 3: AI cannot draft a rule ───────────────────────

describe("POST /api/ai/resolve-schema-intent — no match", () => {
  const PORT = 31981;
  let server: ReturnType<typeof createServer>;
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      kind: "no_match",
      explanation: "This is about creating an entity, not a rule.",
    }),
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns a no_match outcome with no proposal", async () => {
    const { status, json } = await postSchemaIntent(PORT, {
      prompt: "Create a brand new vendor entity",
    });
    expect(status).toBe(200);
    const body = json as { outcome: string; proposal?: unknown; reason?: string };
    expect(body.outcome).toBe("no_match");
    expect(body.proposal).toBeUndefined();
    expect(body.reason).toBe("no_rule_drafted");
  });
});

// ── Scenario 4: Empty prompt → 400 ───────────────────────────

describe("POST /api/ai/resolve-schema-intent — empty prompt", () => {
  const PORT = 31982;
  let server: ReturnType<typeof createServer>;
  const ai = fakeAiService({ responseContent: "{}" });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns 400 for a missing prompt", async () => {
    const { status, json } = await postSchemaIntent(PORT, {});
    expect(status).toBe(400);
    const body = json as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION.FAILED");
  });
});

// ── Scenario 5: AI unavailable → 503 ─────────────────────────

describe("POST /api/ai/resolve-schema-intent — AI unavailable", () => {
  const PORT = 31983;
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      port: PORT,
      aiService: unconfiguredAi,
      ontologyRegistry: buildOntology(),
    });
    server.listen(PORT);
  });

  afterAll(() => {
    server.stop?.();
  });

  test("returns 503 with a structured error", async () => {
    const { status, json } = await postSchemaIntent(PORT, {
      prompt: "Block purchase requests over 10000",
    });
    expect(status).toBe(503);
    const body = json as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
