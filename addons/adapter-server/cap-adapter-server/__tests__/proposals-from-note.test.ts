/**
 * 经验→制度 (first segment) — POST /api/proposals/from-note integration tests.
 *
 * Exercises the real resolver (resolveSchemaIntent) behind the HTTP endpoint,
 * with a deterministic fake AIService (NO real LLM calls). A reviewer promotes
 * a chatter note (经验) into a DRAFT governed Proposal carrying the originating
 * note as `evidence` provenance; the draft lands in the SHARED governed engine
 * `/api/proposals` serves. Scenarios:
 *   1. Happy path — a draft add_rule Proposal is returned, status `draft`.
 *   2. Provenance — the persisted draft records the note as `evidence`, and
 *      surfaces via `/api/proposals` + `/api/proposals/:id`.
 *   3. Entity-draft path also stamps `evidence`.
 *   4. Empty `noteBody` → 400 (Zod), nothing persisted.
 *   5. AI service unavailable → 503 structured error.
 */

import { beforeAll, describe, expect, test } from "bun:test";
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

// In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
// `app.listen` would SEGFAULT the batched addons run as server suites accumulate
// sockets in one process.
const BASE = "http://local.test";

async function postFromNote(
  app: ReturnType<typeof createServer>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/from-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

/** Shape of `GET /api/proposals` (list) JSON. */
interface ProposalsListJson {
  success: boolean;
  data: { items: Array<Record<string, unknown>>; total: number };
}
/** Shape of `GET /api/proposals/:id` (single) JSON. */
interface ProposalByIdJson {
  success: boolean;
  data?: Record<string, unknown>;
}

async function getProposals(
  app: ReturnType<typeof createServer>,
  capability?: string,
): Promise<{ status: number; json: ProposalsListJson }> {
  // The governed engine is a process-global singleton with no public reset, so
  // tests scope their assertions to the capability they create.
  const qs = capability ? `?capability=${encodeURIComponent(capability)}` : "";
  const res = await app.handle(new Request(`${BASE}/api/proposals${qs}`));
  return { status: res.status, json: (await res.json()) as ProposalsListJson };
}

async function getProposalById(
  app: ReturnType<typeof createServer>,
  id: string,
): Promise<{ status: number; json: ProposalByIdJson }> {
  const res = await app.handle(new Request(`${BASE}/api/proposals/${id}`));
  return { status: res.status, json: (await res.json()) as ProposalByIdJson };
}

// ── Scenario 1+2: Happy path + provenance ────────────────────

describe("POST /api/proposals/from-note — rule draft + provenance", () => {
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
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
  });

  test("returns a draft add_rule Proposal carrying the note as evidence", async () => {
    const { status, json } = await postFromNote(server, {
      noteId: "msg-123",
      entityName: "purchase_request",
      recordId: "rec-1",
      noteBody: "Block purchase requests over 10000",
    });
    expect(status).toBe(200);
    const body = json as {
      outcome: string;
      proposal?: { type: string; status: string };
      proposalId?: string;
      proposalStatus?: string;
      ruleName?: string;
    };
    expect(body.outcome).toBe("proposal_draft");
    expect(body.proposal?.type).toBe("add_rule");
    // The "never applies" guarantee — the route stops at draft.
    expect(body.proposal?.status).toBe("draft");
    expect(body.ruleName).toBe("block_overlimit_amount");
    expect(typeof body.proposalId).toBe("string");
    expect((body.proposalId ?? "").length).toBeGreaterThan(0);
    expect(body.proposalStatus).toBe("draft");

    // Provenance — the governed draft records the note as `evidence`, and is
    // retrievable through the existing review API.
    const proposalId = body.proposalId;
    if (!proposalId) throw new Error("expected a governed proposalId");
    const byId = await getProposalById(server, proposalId);
    expect(byId.status).toBe(200);
    expect(byId.json.data?.status).toBe("draft");
    const evidence = byId.json.data?.evidence as
      | { kind?: string; ref?: string; context?: Record<string, unknown> }
      | undefined;
    expect(evidence).toBeDefined();
    expect(evidence?.kind).toBe("chatter_note");
    expect(evidence?.ref).toBe("msg-123");
    expect(evidence?.context?.entityName).toBe("purchase_request");
    expect(evidence?.context?.recordId).toBe("rec-1");

    // Also appears in the capability-scoped list.
    const list = await getProposals(server, "purchase_request");
    const found = list.json.data.items.find((p) => p.id === proposalId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("draft");
    expect((found?.evidence as { ref?: string } | undefined)?.ref).toBe("msg-123");
  });
});

// ── Scenario 3: Entity-draft path also stamps evidence ───────

describe("POST /api/proposals/from-note — entity draft + provenance", () => {
  let server: ReturnType<typeof createServer>;
  const ai = fakeAiService({
    responseContent: JSON.stringify({
      kind: "add_entity",
      entity: {
        name: "product",
        label: "Product",
        fields: [
          { name: "barcode", type: "string", required: false, unique: true },
          { name: "case_pack_quantity", type: "number", required: false, min: 1 },
        ],
      },
      confidence: 0.9,
      explanation: "Add a product catalog entity.",
    }),
  });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
  });

  test("returns an entity_proposal_draft carrying the note as evidence", async () => {
    const { status, json } = await postFromNote(server, {
      noteId: "msg-777",
      entityName: "purchase_request",
      recordId: "rec-9",
      noteBody: "增加一个商品管理，支持条码和箱规",
    });
    expect(status).toBe(200);
    const body = json as {
      outcome: string;
      entityName?: string;
      proposalId?: string;
      proposalStatus?: string;
    };
    expect(body.outcome).toBe("entity_proposal_draft");
    expect(body.entityName).toBe("product");
    expect(body.proposalStatus).toBe("draft");
    const proposalId = body.proposalId;
    expect(typeof proposalId).toBe("string");
    if (!proposalId) throw new Error("expected a governed proposalId");

    const byId = await getProposalById(server, proposalId);
    expect(byId.status).toBe(200);
    expect(byId.json.data?.status).toBe("draft");
    const evidence = byId.json.data?.evidence as
      | { kind?: string; ref?: string; context?: Record<string, unknown> }
      | undefined;
    expect(evidence?.kind).toBe("chatter_note");
    expect(evidence?.ref).toBe("msg-777");
    expect(evidence?.context?.entityName).toBe("purchase_request");
    expect(evidence?.context?.recordId).toBe("rec-9");
  });
});

// ── Scenario 4: Empty noteBody → 400 (Zod), nothing persisted ─

describe("POST /api/proposals/from-note — empty noteBody", () => {
  let server: ReturnType<typeof createServer>;
  const ai = fakeAiService({ responseContent: "{}" });

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: ai,
      ontologyRegistry: buildOntology(),
    });
  });

  test("returns 400 for an empty noteBody and persists nothing", async () => {
    const before = (await getProposals(server, "purchase_request")).json.data.total;
    const { status, json } = await postFromNote(server, {
      noteId: "msg-1",
      entityName: "purchase_request",
      recordId: "rec-1",
      noteBody: "",
    });
    expect(status).toBe(400);
    const body = json as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION.FAILED");
    const after = (await getProposals(server, "purchase_request")).json.data.total;
    expect(after).toBe(before);
  });
});

// ── Scenario 5: AI unavailable → 503 ─────────────────────────

describe("POST /api/proposals/from-note — AI unavailable", () => {
  let server: ReturnType<typeof createServer>;

  beforeAll(() => {
    server = createServer(graphqlSchema, {
      aiService: unconfiguredAi,
      ontologyRegistry: buildOntology(),
    });
  });

  test("returns 503 with a structured error", async () => {
    const { status, json } = await postFromNote(server, {
      noteId: "msg-1",
      entityName: "purchase_request",
      recordId: "rec-1",
      noteBody: "Block purchase requests over 10000",
    });
    expect(status).toBe(503);
    const body = json as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
