/**
 * Spec 52 §2.6 — POST /api/ai/resolve-intent integration tests.
 *
 * Exercises the canonical resolver-driven endpoint. Six scenarios cover:
 *   1. Happy path — resolved proposal + audit entry written.
 *   2. AI cannot match — null proposal + audit entry.
 *   3. Empty prompt — 400 (Zod validation).
 *   4. AI service unavailable — 503 with structured error.
 *   5. Permission filtering — actor lacks permission for an action; the
 *      resolver's catalog must NOT include it (verified by audit catalogSize
 *      and the deterministic-AI behavior).
 *   6. Audit entry shape — kind/result/duration/prompt/catalogSize.
 *
 * All tests use a deterministic fake AIService — no real LLM calls.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  Actor,
  AIService,
  EntityDefinition,
  PermissionGroupDefinition,
} from "@linchkit/core";
import {
  ActionRegistry,
  AIAuditLogger,
  createOntologyRegistry,
  EntityRegistry,
  PermissionRegistry,
} from "@linchkit/core/server";
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
    description: { type: "text", label: "Description" },
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
  },
  policy: "unrestricted",
};

const deleteEverythingAction: ActionDefinition = {
  name: "delete_everything",
  entity: "purchase_request",
  label: "Delete Everything",
  description: "Wipe the world. Demo of a permission-gated action.",
  policy: "unrestricted",
};

const graphqlSchema = buildGraphQLSchema([purchaseSchema]);

// ── Helpers ──────────────────────────────────────────────────

function buildOntology(actions: ActionDefinition[]): {
  ontology: ReturnType<typeof createOntologyRegistry>;
  entityRegistry: EntityRegistry;
  actionRegistry: ActionRegistry;
} {
  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseSchema);
  const actionRegistry = new ActionRegistry();
  for (const a of actions) actionRegistry.register(a);
  const ontology = createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules: [],
    states: [],
    views: [],
  });
  return { ontology, entityRegistry, actionRegistry };
}

interface FakeAiServiceOptions {
  /** When set, used as the AI completion content verbatim. */
  responseContent?: string;
  /**
   * When set, called with the system prompt to derive the response. Allows
   * tests to assert what catalog the AI saw.
   */
  buildResponse?: (systemPrompt: string, userPrompt: string) => string;
  /** Optional model name surfaced in the response. */
  model?: string;
  /** When true, `complete()` throws — exercises graceful-degradation. */
  fail?: boolean;
}

function fakeAiService(opts: FakeAiServiceOptions): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
      if (opts.fail) {
        throw new Error("simulated AI failure");
      }
      const systemPrompt = req.messages.find((m) => m.role === "system")?.content ?? "";
      const userPrompt = req.messages.find((m) => m.role === "user")?.content ?? "";
      const content = opts.responseContent ?? opts.buildResponse?.(systemPrompt, userPrompt) ?? "";
      return {
        content,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        model: opts.model ?? "fake-model",
        provider: "fake",
        duration: 5,
      };
    },
  } as unknown as AIService;
}

const noopAiService: AIService = {
  configured: false,
  defaultProvider: null,
  providerNames: [],
  complete: async () => {
    throw new Error("AI not configured");
  },
} as unknown as AIService;

const ANON_ACTOR: Actor = {
  type: "system",
  id: "test-anon",
  groups: [],
};

// In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
// A dummy domain is used since no socket is bound (`app.listen` would SEGFAULT the
// batched addons run when many server suites accumulate sockets in one process).
const BASE = "http://local.test";

async function postResolveIntent(
  app: ReturnType<typeof createServer>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.handle(
    new Request(`${BASE}/api/ai/resolve-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

// ── Scenario 1: Happy path ───────────────────────────────────

describe("POST /api/ai/resolve-intent — happy path", () => {
  let server: ReturnType<typeof createServer>;
  const auditLogger = new AIAuditLogger();
  const { ontology } = buildOntology([createPurchaseAction]);
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      action: "create_purchase_request",
      input: { amount: 5000, department: "General Admin" },
      confidence: 0.92,
      explanation: "Create a purchase request for 5000 General Admin.",
    }),
    model: "happy-model",
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger,
      resolveRequestActor: () => ANON_ACTOR,
    });
  });

  test("returns ActionProposal and writes one matched=true audit entry", async () => {
    const { status, json } = await postResolveIntent(server, {
      prompt: "Create a purchase request for 5000 for General Admin",
    });
    expect(status).toBe(200);
    const body = json as {
      proposal: {
        action: string;
        input: Record<string, unknown>;
        confidence: number;
        missingFields: string[];
        explanation: string;
      } | null;
    };
    expect(body.proposal).not.toBeNull();
    if (!body.proposal) throw new Error("expected proposal to be set");
    expect(body.proposal.action).toBe("create_purchase_request");
    expect(body.proposal.input.amount).toBe(5000);
    expect(body.proposal.input.department).toBe("General Admin");
    expect(body.proposal.confidence).toBeCloseTo(0.92, 5);
    // Required fields the AI did not fill (amount + department are filled,
    // description is non-required so should not appear here).
    expect(body.proposal.missingFields).toEqual([]);
    expect(body.proposal.explanation.length).toBeGreaterThan(0);

    // Audit entry: exactly one, matched=true, eventType='intent_resolution'
    const entries = auditLogger.query();
    expect(entries.length).toBe(1);
    expect(entries[0]?.eventType).toBe("intent_resolution");
    const meta = entries[0]?.metadata as Record<string, unknown> | undefined;
    expect((meta?.result as { matched: boolean }).matched).toBe(true);
    expect((meta?.result as { action: string | null }).action).toBe("create_purchase_request");
    expect((meta?.result as { confidence: number | null }).confidence).toBeCloseTo(0.92, 5);
    expect(typeof meta?.durationMs).toBe("number");
    expect(meta?.prompt).toBe("Create a purchase request for 5000 for General Admin");
  });
});

// ── Scenario 2: AI cannot match ──────────────────────────────

describe("POST /api/ai/resolve-intent — AI cannot match", () => {
  let server: ReturnType<typeof createServer>;
  const auditLogger = new AIAuditLogger();
  const { ontology } = buildOntology([createPurchaseAction]);
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      action: null,
      input: {},
      confidence: 0.0,
      explanation: "Couldn't make sense of that.",
    }),
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger,
      resolveRequestActor: () => ANON_ACTOR,
    });
  });

  test("returns { proposal: null } and writes one matched=false audit entry", async () => {
    const { status, json } = await postResolveIntent(server, {
      prompt: "Recite a sonnet about TypeScript.",
    });
    expect(status).toBe(200);
    expect((json as { proposal: unknown }).proposal).toBeNull();

    const entries = auditLogger.query();
    expect(entries.length).toBe(1);
    expect(entries[0]?.eventType).toBe("intent_resolution");
    const meta = entries[0]?.metadata as Record<string, unknown> | undefined;
    expect((meta?.result as { matched: boolean }).matched).toBe(false);
    expect((meta?.result as { action: string | null }).action).toBeNull();
  });
});

// ── Scenario 3: Empty prompt → 400 (Zod) ─────────────────────

describe("POST /api/ai/resolve-intent — empty prompt", () => {
  let server: ReturnType<typeof createServer>;
  const { ontology } = buildOntology([createPurchaseAction]);
  const ai = fakeAiService({
    responseContent: JSON.stringify({ action: null, confidence: 0 }),
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: ontology,
    });
  });

  test("rejects empty prompt with 400 + structured error", async () => {
    const { status, json } = await postResolveIntent(server, { prompt: "" });
    expect(status).toBe(400);
    const body = json as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION.FAILED");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  test("rejects request without prompt field with 400", async () => {
    const { status, json } = await postResolveIntent(server, {});
    expect(status).toBe(400);
    const body = json as { success: boolean };
    expect(body.success).toBe(false);
  });
});

// ── Scenario 4: AI service unavailable → 503 ─────────────────

describe("POST /api/ai/resolve-intent — AI unavailable", () => {
  let server: ReturnType<typeof createServer>;
  const auditLogger = new AIAuditLogger();
  const { ontology } = buildOntology([createPurchaseAction]);

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      // No aiService configured → graceful 503
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger,
    });
  });

  test("returns 503 with structured error envelope when no AI service is configured", async () => {
    const { status, json } = await postResolveIntent(server, {
      prompt: "Create something",
    });
    expect(status).toBe(503);
    const body = json as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message.toLowerCase()).toContain("ai");
  });

  test("returns 503 when aiService.configured === false", async () => {
    const auditLogger2 = new AIAuditLogger();
    const server2 = createServer(graphqlSchema, {
      aiService: noopAiService,
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger2,
    });
    const { status } = await postResolveIntent(server2, { prompt: "anything" });
    expect(status).toBe(503);
    // Audit entry still emitted so volume is observable.
    const entries = auditLogger2.query();
    expect(entries.length).toBe(1);
    expect(entries[0]?.eventType).toBe("intent_resolution");
    const meta = entries[0]?.metadata as Record<string, unknown> | undefined;
    expect(meta?.serviceUnavailable).toBe(true);
  });
});

// ── Scenario 5: Permission filtering ─────────────────────────

describe("POST /api/ai/resolve-intent — permission filtering", () => {
  let server: ReturnType<typeof createServer>;
  const auditLogger = new AIAuditLogger();
  // Build an ontology with TWO actions; the actor is allowed to execute
  // create_purchase_request but NOT delete_everything.
  const { ontology } = buildOntology([createPurchaseAction, deleteEverythingAction]);
  const permissionRegistry = new PermissionRegistry();
  const groupName = "viewer";
  const viewerGroup: PermissionGroupDefinition = {
    name: groupName,
    permissions: {
      // Capability name follows permission-middleware.ts convention:
      // capabilityName === action.entity when no resolver is configured.
      purchase_request: {
        purchase_request: {
          actions: {
            create_purchase_request: true,
            delete_everything: false,
          },
        },
      },
    },
  };
  permissionRegistry.register(viewerGroup);

  // Capture the system prompt the AI sees so we can assert that
  // delete_everything was NOT included in the catalog.
  let capturedSystemPrompt = "";
  const ai = fakeAiService({
    buildResponse: (systemPrompt) => {
      capturedSystemPrompt = systemPrompt;
      // The AI returns null because we don't even want it proposing the
      // permitted action — we're only asserting the catalog was scoped.
      return JSON.stringify({ action: null, confidence: 0, explanation: "n/a" });
    },
  });
  const viewerActor: Actor = {
    type: "human",
    id: "viewer-1",
    groups: [groupName],
  };

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger,
      permissionRegistry,
      resolveRequestActor: () => viewerActor,
    });
  });

  test("filters out actions the actor cannot execute from the resolver's catalog", async () => {
    const { status } = await postResolveIntent(server, {
      prompt: "Erase everything immediately.",
    });
    expect(status).toBe(200);
    // Verify the captured system prompt mentions create_purchase_request but
    // NOT delete_everything (the explicit-deny action).
    expect(capturedSystemPrompt).toContain("create_purchase_request");
    expect(capturedSystemPrompt).not.toContain("delete_everything");

    // Audit entry confirms catalog scoping is active.
    const entries = auditLogger.query();
    expect(entries.length).toBe(1);
    const meta = entries[0]?.metadata as Record<string, unknown> | undefined;
    expect(meta?.scoped).toBe(true);
    expect(meta?.catalogSize).toBe(1);
  });
});

// ── Scenario 6: Audit entry shape ────────────────────────────

describe("POST /api/ai/resolve-intent — audit entry shape", () => {
  let server: ReturnType<typeof createServer>;
  const auditLogger = new AIAuditLogger();
  const { ontology } = buildOntology([createPurchaseAction]);
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      action: "create_purchase_request",
      input: { amount: 100, department: "Eng" },
      confidence: 0.7,
      explanation: "create_purchase_request fits.",
    }),
    model: "audit-model",
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: ontology,
      aiAuditLogger: auditLogger,
      resolveRequestActor: () => ANON_ACTOR,
    });
  });

  test("audit entry contains all expected fields", async () => {
    await postResolveIntent(server, { prompt: "create a purchase for 100 Eng" });
    const entries = auditLogger.query();
    expect(entries.length).toBe(1);
    const entry = entries[0];
    if (!entry) throw new Error("expected audit entry");
    // Top-level AIAuditEntry shape (from packages/core/src/ai/ai-audit.ts).
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.timestamp).toBe("string");
    // Canonical Spec 52 §8.1.4 event type — no longer co-opting ai_recommendation.
    expect(entry.eventType).toBe("intent_resolution");
    expect(entry.actorId).toBe("test-anon");
    expect(entry.actionName).toBe("create_purchase_request");
    // Spec 52 §8.1.4-shaped payload lives under `metadata`.
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.prompt).toBe("create a purchase for 100 Eng");
    const result = meta.result as { matched: boolean; action: string | null; confidence: number };
    expect(result.matched).toBe(true);
    expect(result.action).toBe("create_purchase_request");
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.serviceUnavailable).toBe(false);
    expect(typeof meta.catalogSize).toBe("number");
    expect(meta.catalogSize).toBe(1);
  });
});
