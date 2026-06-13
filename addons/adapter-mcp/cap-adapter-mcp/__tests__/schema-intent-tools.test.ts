/**
 * Spec 52 "说→有" (issue #583) — `resolve_schema_intent` MCP tool tests.
 *
 * The MCP-channel sibling of the HTTP test
 * `adapter-server/__tests__/ai-resolve-schema-intent.test.ts`. Exercises the
 * real resolver (`resolveSchemaIntent`) behind the MCP tool, with a
 * deterministic fake AIService (no real LLM calls). A validated draft is
 * PERSISTED into the GOVERNED ProposalEngine the MCP server's
 * `create_proposal` / `list_proposals` tools share, so it surfaces in the
 * review pipeline (`/api/proposals`).
 *
 * Scenarios:
 *   1. add_entity → entity draft returned + governed proposal persisted (draft).
 *   2. add_rule → rule draft returned + governed proposal persisted (draft).
 *   3. AI not configured → structured unavailable error, nothing persisted.
 *   4. Permission denied via checkToolPolicy → blocked, nothing persisted.
 *   5. no_match → nothing persisted (not a governed change).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  Actor,
  AIService,
  EntityDefinition,
  RuleDefinition,
} from "@linchkit/core";
import {
  ActionRegistry,
  createOntologyRegistry,
  createProposalEngine,
  EntityRegistry,
} from "@linchkit/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSchemaIntentTools } from "../src/schema-intent-tools";

// ── Test harness (mirrors proposal-tools.test.ts) ───────────

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

type ToolsMap = Record<string, RegisteredTool>;

function getTools(server: unknown): ToolsMap {
  return (server as { _registeredTools: ToolsMap })._registeredTools;
}

function parseToolResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "");
}

// ── Fixtures ────────────────────────────────────────────────

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

function buildOntology(rules: RuleDefinition[] = []): ReturnType<typeof createOntologyRegistry> {
  const entityRegistry = new EntityRegistry();
  entityRegistry.register(purchaseSchema);
  const actionRegistry = new ActionRegistry();
  actionRegistry.register(createPurchaseAction);
  return createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules,
    states: [],
    views: [],
  });
}

interface FakeAiServiceOptions {
  responseContent?: string;
}

function fakeAiService(opts: FakeAiServiceOptions): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async () => ({
      content: opts.responseContent ?? "",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      model: "fake-model",
      provider: "fake",
      duration: 5,
    }),
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

/** Build a server with the resolve_schema_intent tool registered. */
function setup(opts: {
  aiService: AIService;
  rules?: RuleDefinition[];
  permissionRegistry?: import("@linchkit/core").PermissionRegistry;
  actor?: Actor;
  checkToolPolicy?: (
    toolName: string,
    category: string,
  ) => { content: Array<{ type: "text"; text: string }>; isError: true } | undefined;
}): {
  tools: ToolsMap;
  proposalEngine: ReturnType<typeof createProposalEngine>;
} {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const proposalEngine = createProposalEngine();
  registerSchemaIntentTools(server, {
    aiService: opts.aiService,
    ontologyRegistry: buildOntology(opts.rules),
    proposalEngine,
    permissionRegistry: opts.permissionRegistry,
    getSessionActor: () => opts.actor,
    checkToolPolicy: opts.checkToolPolicy,
  });
  return { tools: getTools(server), proposalEngine };
}

// ── Scenario 1: add_entity ──────────────────────────────────

describe("resolve_schema_intent — add_entity", () => {
  let tools: ToolsMap;
  let proposalEngine: ReturnType<typeof createProposalEngine>;

  beforeEach(() => {
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
    ({ tools, proposalEngine } = setup({ aiService: ai }));
  });

  test("registers the resolve_schema_intent tool", () => {
    expect(tools.resolve_schema_intent).toBeDefined();
  });

  test("returns the entity draft and persists a governed proposal (draft)", async () => {
    const result = await tools.resolve_schema_intent?.handler(
      { prompt: "增加一个商品管理，支持条码和箱规" },
      {},
    );
    expect(result?.isError).toBeUndefined();
    const body = parseToolResult(result) as {
      outcome: string;
      entityName?: string;
      fields?: Array<{ name: string }>;
      proposalId?: string;
      proposalStatus?: string;
    };
    expect(body.outcome).toBe("entity_proposal_draft");
    expect(body.entityName).toBe("product");
    expect((body.fields ?? []).map((f) => f.name).sort()).toEqual(
      ["barcode", "case_pack_quantity"].sort(),
    );
    expect(typeof body.proposalId).toBe("string");
    expect(body.proposalStatus).toBe("draft");

    // Persisted into the SAME engine list_proposals serves, scoped to the entity.
    const persisted = proposalEngine.listProposals({ capability: "product" });
    expect(persisted).toHaveLength(1);
    const found = persisted.find((p) => p.id === body.proposalId);
    expect(found).toBeDefined();
    if (!found) throw new Error("expected the governed entity draft");
    expect(found.status).toBe("draft");
    const changes = found.changes as Array<{ target: string; operation: string; name: string }>;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.target).toBe("entity");
    expect(changes[0]?.operation).toBe("create");
    expect(changes[0]?.name).toBe("product");
    // Audit trail — records WHO requested the resolution.
    expect(String(found.description ?? "")).toContain("Requested by");
  });
});

// ── Scenario 2: add_rule ────────────────────────────────────

describe("resolve_schema_intent — add_rule", () => {
  let tools: ToolsMap;
  let proposalEngine: ReturnType<typeof createProposalEngine>;

  beforeEach(() => {
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
    ({ tools, proposalEngine } = setup({ aiService: ai }));
  });

  test("returns the rule draft and persists a governed proposal (draft)", async () => {
    const result = await tools.resolve_schema_intent?.handler(
      { prompt: "Block purchase requests over 10000" },
      {},
    );
    expect(result?.isError).toBeUndefined();
    const body = parseToolResult(result) as {
      outcome: string;
      ruleName?: string;
      targetEntity?: string;
      operation?: string;
      proposalId?: string;
      proposalStatus?: string;
    };
    expect(body.outcome).toBe("proposal_draft");
    expect(body.ruleName).toBe("block_overlimit_amount");
    expect(body.targetEntity).toBe("purchase_request");
    expect(body.operation).toBe("create");
    expect(typeof body.proposalId).toBe("string");
    expect(body.proposalStatus).toBe("draft");

    const persisted = proposalEngine.listProposals({ capability: "purchase_request" });
    const found = persisted.find((p) => p.id === body.proposalId);
    expect(found).toBeDefined();
    if (!found) throw new Error("expected the governed rule draft");
    expect(found.status).toBe("draft");
    const changes = found.changes as Array<{
      target: string;
      operation: string;
      name: string;
      definition?: Record<string, unknown>;
    }>;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.target).toBe("rule");
    expect(changes[0]?.operation).toBe("create");
    expect(changes[0]?.name).toBe("block_overlimit_amount");
    expect(changes[0]?.definition?.condition).toEqual({
      field: "amount",
      operator: "gt",
      value: 10000,
    });
  });
});

// ── Scenario 3: AI not configured ───────────────────────────

describe("resolve_schema_intent — AI not configured", () => {
  test("returns a structured unavailable error and persists nothing", async () => {
    const { tools, proposalEngine } = setup({ aiService: unconfiguredAi });
    const result = await tools.resolve_schema_intent?.handler(
      { prompt: "Block purchase requests over 10000" },
      {},
    );
    expect(result?.isError).toBe(true);
    const body = parseToolResult(result) as { error: string; message: string };
    expect(body.error).toBe("unavailable");
    expect(body.message.length).toBeGreaterThan(0);
    // Nothing reaches the governed engine.
    expect(proposalEngine.listProposals({})).toHaveLength(0);
  });
});

// ── Scenario 4: permission denied via checkToolPolicy ───────

describe("resolve_schema_intent — blocked by tool policy", () => {
  test("checkToolPolicy short-circuits → blocked, nothing persisted", async () => {
    const ai = fakeAiService({
      responseContent: JSON.stringify({
        kind: "add_rule",
        targetEntity: "purchase_request",
        rule: {
          name: "block_overlimit_amount",
          label: "Block over-limit amount",
          trigger: { action: "create_purchase_request" },
          condition: { field: "amount", operator: "gt", value: 10000 },
          effect: { type: "block", message: "too big" },
        },
        confidence: 0.9,
        explanation: "x",
      }),
    });
    const { tools, proposalEngine } = setup({
      aiService: ai,
      checkToolPolicy: (toolName, category) => {
        // Deny the resolve_schema_intent tool for this session.
        if (toolName === "resolve_schema_intent" && category === "proposals") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Tool not allowed by client policy" }),
              },
            ],
            isError: true as const,
          };
        }
        return undefined;
      },
    });

    const result = await tools.resolve_schema_intent?.handler(
      { prompt: "Block purchase requests over 10000" },
      {},
    );
    expect(result?.isError).toBe(true);
    const body = parseToolResult(result) as { error: string };
    expect(body.error).toBe("Tool not allowed by client policy");
    // Policy short-circuits BEFORE the AI is called — nothing governed.
    expect(proposalEngine.listProposals({})).toHaveLength(0);
  });
});

// ── Scenario 5: no_match persists nothing ───────────────────

describe("resolve_schema_intent — no_match", () => {
  test("returns no_match and persists nothing", async () => {
    const ai = fakeAiService({
      responseContent: JSON.stringify({
        kind: "no_match",
        explanation: "This is about creating an entity, not a rule.",
      }),
    });
    const { tools, proposalEngine } = setup({ aiService: ai });
    const result = await tools.resolve_schema_intent?.handler(
      { prompt: "Create a brand new vendor entity" },
      {},
    );
    expect(result?.isError).toBeUndefined();
    const body = parseToolResult(result) as { outcome: string; proposalId?: unknown };
    expect(body.outcome).toBe("no_match");
    expect(body.proposalId).toBeUndefined();
    expect(proposalEngine.listProposals({})).toHaveLength(0);
  });
});
