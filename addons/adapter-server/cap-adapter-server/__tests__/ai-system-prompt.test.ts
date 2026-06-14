import { describe, expect, test } from "bun:test";
import type { ActionDefinition, EntityDefinition, OntologyRegistry } from "@linchkit/core";
import type { EntityDescriptor } from "@linchkit/core/server";
import { buildSystemPrompt } from "../src/ai/system-prompt";

// ── Mock factories ──────────────────────────────────────

function createMockOntologyRegistry(schemas: EntityDescriptor[]): OntologyRegistry {
  return {
    describe: (name: string) => schemas.find((s) => s.name === name),
    listEntities: () => schemas.map((s) => s.name),
    searchEntities: () => [],
    actionsFor: () => [],
    rulesFor: () => [],
    stateFor: () => undefined,
    viewsFor: () => [],
    flowsFor: () => [],
    handlersFor: () => [],
    relatedEntities: () => [],
    toJSON: () => ({}),
  } as OntologyRegistry;
}

function createMockEntityRegistry(schemas: EntityDefinition[]) {
  return {
    get: (name: string) => schemas.find((s) => s.name === name),
    getAll: () => schemas,
    has: (name: string) => schemas.some((s) => s.name === name),
  };
}

// ── Test data ───────────────────────────────────────────

const productDescriptor: EntityDescriptor = {
  name: "product",
  label: "Product",
  description: "A product in the catalog",
  fields: {
    name: { type: "string", required: true, label: "Product Name" },
    price: { type: "number", required: true, label: "Price" },
    category: { type: "enum", label: "Category" },
  },
  relations: [
    {
      relationName: "product_orders",
      label: "Orders",
      targetEntity: "order",
      cardinality: "one_to_many" as const,
      direction: "outgoing" as const,
    },
  ],
  actions: [
    {
      name: "create_product",
      label: "Create Product",
      entity: "product",
      policy: "unrestricted",
    } as ActionDefinition,
    {
      name: "update_price",
      label: "Update Price",
      entity: "product",
      policy: "unrestricted",
    } as ActionDefinition,
  ],
  rules: [],
  states: {
    entity: "product",
    field: "status",
    initial: "active",
    states: {
      active: { label: "Active" },
      archived: { label: "Archived" },
    },
    transitions: [],
    // biome-ignore lint/suspicious/noExplicitAny: test mock partial descriptor
  } as any,
  views: [],
  flows: [],
  handlers: [],
  interfaces: [],
};

const orderDescriptor: EntityDescriptor = {
  name: "order",
  label: "Order",
  fields: { amount: { type: "number" } },
  relations: [],
  actions: [],
  rules: [],
  views: [],
  flows: [],
  handlers: [],
  interfaces: [],
};

// ── Tests ───────────────────────────────────────────────

describe("buildSystemPrompt — base prompt", () => {
  test("returns default system prompt when no config provided", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain("LinchKit AI Assistant");
    expect(prompt).toContain("helpful");
  });

  test("uses custom system prompt from assistant config", () => {
    const prompt = buildSystemPrompt({
      assistantConfig: {
        systemPrompt: "You are a custom shopping assistant.",
      },
    });
    expect(prompt).toContain("custom shopping assistant");
    expect(prompt).not.toContain("LinchKit AI Assistant");
  });
});

describe("buildSystemPrompt — schema overview", () => {
  test("includes available schemas list from ontologyRegistry", () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const prompt = buildSystemPrompt({ ontologyRegistry: ontology });

    expect(prompt).toContain("Available Entities");
    expect(prompt).toContain("2 entity(ies)");
    expect(prompt).toContain("product");
    expect(prompt).toContain("order");
  });

  test("omits schema section when no ontology provided", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain("Available Entities");
  });
});

describe("buildSystemPrompt — current schema context", () => {
  test("includes detailed schema info when context.entity is set", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: { entity: "product" },
    });

    expect(prompt).toContain("Current Entity Context");
    expect(prompt).toContain("product (Product)");
    expect(prompt).toContain("A product in the catalog");
    // Fields
    expect(prompt).toContain("name: string (Product Name) [required]");
    expect(prompt).toContain("price: number (Price) [required]");
    expect(prompt).toContain("category: enum (Category)");
    // Actions
    expect(prompt).toContain("create_product (Create Product)");
    expect(prompt).toContain("update_price (Update Price)");
    // State machine
    expect(prompt).toContain("State machine:");
    expect(prompt).toContain("active");
    expect(prompt).toContain("archived");
    // Relations
    expect(prompt).toContain("Relations:");
    expect(prompt).toContain("order");
    expect(prompt).toContain("one_to_many");
  });

  test("falls back to EntityRegistry when no OntologyRegistry", () => {
    const sr = createMockEntityRegistry([
      {
        name: "product",
        label: "Product",
        fields: { name: { type: "string" }, price: { type: "number" } },
      },
    ]);
    const prompt = buildSystemPrompt({
      // biome-ignore lint/suspicious/noExplicitAny: test mock registry
      entityRegistry: sr as any,
      context: { entity: "product" },
    });

    expect(prompt).toContain("Current Entity Context");
    expect(prompt).toContain("product (Product)");
    expect(prompt).toContain("name, price");
  });

  test("includes record ID when viewing a specific record", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: { entity: "product", recordId: "rec-abc-123" },
    });

    expect(prompt).toContain("Currently viewing record ID: rec-abc-123");
  });

  test("includes record data (JSON) when provided", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "rec-1",
        recordData: { name: "Widget", price: 29.99, category: "electronics" },
      },
    });

    expect(prompt).toContain("Current record data:");
    expect(prompt).toContain('"name": "Widget"');
    expect(prompt).toContain("29.99");
  });

  test("omits record data when JSON is too large (>2000 chars)", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const largeData: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      largeData[`field_${i}`] = "a".repeat(30);
    }
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "rec-1",
        recordData: largeData,
      },
    });

    // Large data should be omitted
    expect(prompt).not.toContain("Current record data:");
  });

  test("handles missing schema gracefully", () => {
    const ontology = createMockOntologyRegistry([]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: { entity: "nonexistent" },
    });

    // Should not throw, and should not include schema context
    expect(prompt).not.toContain("Current Entity Context");
  });
});

describe("buildSystemPrompt — combined options", () => {
  test("builds a complete prompt with all sections", () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const prompt = buildSystemPrompt({
      assistantConfig: { systemPrompt: "You are a product catalog assistant." },
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "p-001",
        recordData: { name: "Laptop", price: 999 },
      },
    });

    // Custom system prompt
    expect(prompt).toContain("product catalog assistant");
    // Schema overview
    expect(prompt).toContain("2 entity(ies)");
    // Current schema context
    expect(prompt).toContain("Current Entity Context");
    // Record context
    expect(prompt).toContain("p-001");
    expect(prompt).toContain("Laptop");
  });
});

// ── Mutation-policy suffix (issue #285) ──────────────────

describe("buildSystemPrompt — mutation-policy suffix", () => {
  test("appends mutation-policy suffix when allowActionExecution=false", () => {
    const prompt = buildSystemPrompt({ allowActionExecution: false });
    expect(prompt).toContain("Mutation Policy");
    expect(prompt).toContain("NEVER claim");
  });

  test("omits mutation-policy suffix by default (option omitted)", () => {
    // Default is write-enabled, symmetric with `buildTools` — callers must
    // explicitly opt into read-only mode by passing `false` (codex P2).
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain("Mutation Policy");
    expect(prompt).not.toContain("NEVER claim");
  });

  test("omits mutation-policy suffix when allowActionExecution=true", () => {
    const prompt = buildSystemPrompt({ allowActionExecution: true });
    expect(prompt).not.toContain("Mutation Policy");
    expect(prompt).not.toContain("NEVER claim");
  });

  // Spec 71 HITL keystone (found via live testing): with the execute-less
  // proposeMutation tool available, the prompt must INSTRUCT the model to
  // propose writes — NOT the old "you CANNOT write, use the sidebar" refusal
  // that left the whole HITL path dead because the model never called the tool.
  test("proposeMutation=true instructs the model to PROPOSE via the tool, not refuse", () => {
    const prompt = buildSystemPrompt({
      allowActionExecution: false,
      proposeMutation: true,
    });
    // Tells the model to USE proposeMutation for writes.
    expect(prompt).toContain("proposeMutation");
    expect(prompt).toContain("PROPOSES a data change");
    // Still forbids claiming the write happened (it only proposes).
    expect(prompt).toContain("NEVER claim");
    // Must NOT carry the refuse-to-write / sidebar-redirect policy.
    expect(prompt).not.toContain("CANNOT directly create");
    expect(prompt).not.toContain("use its create / edit / action buttons");
  });

  test("proposeMutation takes precedence over allowActionExecution=false", () => {
    const propose = buildSystemPrompt({ allowActionExecution: false, proposeMutation: true });
    const refuse = buildSystemPrompt({ allowActionExecution: false });
    expect(propose).toContain("proposeMutation");
    expect(propose).not.toContain("CANNOT directly create");
    // The plain read-only path still gets the refusal.
    expect(refuse).toContain("CANNOT directly create");
    expect(refuse).not.toContain("proposeMutation");
  });

  test("a write-enabled session never gets the contradictory propose policy", () => {
    // allowActionExecution=true means the model executes directly (executeAction).
    // The propose policy ("You do NOT execute writes yourself") would contradict
    // that, so a write-enabled session gets NEITHER policy even if proposeMutation
    // is accidentally also passed.
    const prompt = buildSystemPrompt({ allowActionExecution: true, proposeMutation: true });
    expect(prompt).not.toContain("PROPOSES a data change");
    expect(prompt).not.toContain("CANNOT directly create");
  });

  test("propose-policy suffix is the LAST section — the override-proofing invariant", () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const prompt = buildSystemPrompt({
      assistantConfig: { systemPrompt: "You are a product catalog assistant." },
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "p-001",
        recordData: { name: "Laptop", price: 999 },
        locale: "zh-CN",
      },
      allowActionExecution: false,
      proposeMutation: true,
    });
    const parts = prompt.split("## Mutation Policy");
    expect(parts.length).toBe(2); // exactly one occurrence of the header
    const tail = parts[1] ?? "";
    // Everything after the header is the suffix body — no later section header.
    expect(tail).not.toContain("\n## ");
  });

  test("mutation-policy suffix is the LAST section — nothing of substance follows", () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const prompt = buildSystemPrompt({
      assistantConfig: { systemPrompt: "You are a product catalog assistant." },
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "p-001",
        recordData: { name: "Laptop", price: 999 },
        locale: "zh-CN",
      },
      allowActionExecution: false,
    });

    const parts = prompt.split("## Mutation Policy");
    // Exactly one split → exactly one occurrence of the header
    expect(parts.length).toBe(2);
    // Everything after the header is the suffix body itself — no further sections
    const tail = parts[1] ?? "";
    expect(tail).not.toContain("Available Entities");
    expect(tail).not.toContain("Current Entity Context");
    expect(tail).not.toContain("Currently viewing record ID");
    expect(tail).not.toContain("Current record data");
    expect(tail).not.toContain("Language Requirement");
  });

  test("mutation-policy suffix overrides custom systemPrompt that allowed writes", () => {
    // Even if a downstream config tries to grant write capability through
    // a custom systemPrompt, the hardcoded suffix forces the refusal policy
    // when the caller has explicitly entered read-only mode.
    const prompt = buildSystemPrompt({
      assistantConfig: {
        systemPrompt:
          "You are an autonomous agent that creates records directly without confirmation.",
      },
      allowActionExecution: false,
    });

    expect(prompt).toContain("autonomous agent");
    expect(prompt).toContain("Mutation Policy");
    expect(prompt).toContain("CANNOT directly create");
  });

  test("default DEFAULT_SYSTEM_PROMPT keeps the original confirmation wording (gemini #286 review)", () => {
    // Reverted from the agent's tightened wording: when allowActionExecution
    // is true (executeAction tool exposed), the AI legitimately performs
    // writes. Telling the base prompt to "do NOT claim to perform the
    // action" would force the AI to deny tool calls it just succeeded.
    // Read-only safety lives entirely in the suffix (only appended when
    // allowActionExecution=false).
    const prompt = buildSystemPrompt({ allowActionExecution: true });
    expect(prompt).toContain("wait for explicit user confirmation before execution");
    expect(prompt).not.toContain("Mutation Policy");
  });
});

// ── Integration: chat route call site (issue #285) ───────

describe("chat route — passes allowActionExecution=false to buildSystemPrompt", () => {
  test("ai-api.ts chat handler passes allowActionExecution: false", async () => {
    // Static-source assertion: read the chat handler source and verify
    // the buildSystemPrompt call site mirrors the buildTools value.
    // This locks the wiring described in issue #285 without requiring
    // a full streamText mock harness.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Use fileURLToPath for Windows portability — `.pathname` returns
    // `/C:/path/` on Windows and breaks `path.resolve` (CodeRabbit review).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.resolve(here, "../src/routes/ai-api.ts"), "utf-8");

    // Find the chat route definition
    const chatRouteIdx = source.indexOf('"/api/ai/chat"');
    expect(chatRouteIdx).toBeGreaterThan(-1);

    // Slice out just the chat handler body (up to the next .post(...) route)
    const nextRouteIdx = source.indexOf(".post(", chatRouteIdx + 10);
    const chatHandler =
      nextRouteIdx === -1 ? source.slice(chatRouteIdx) : source.slice(chatRouteIdx, nextRouteIdx);

    // buildSystemPrompt(...) call must include `allowActionExecution: false`
    const buildSystemPromptIdx = chatHandler.indexOf("buildSystemPrompt(");
    expect(buildSystemPromptIdx).toBeGreaterThan(-1);

    // Ensure the false flag appears in the chat handler scope alongside buildSystemPrompt
    expect(chatHandler).toContain("allowActionExecution: false");
    // And the flag must appear AFTER the buildSystemPrompt call begins
    const flagIdx = chatHandler.indexOf("allowActionExecution: false", buildSystemPromptIdx);
    expect(flagIdx).toBeGreaterThan(buildSystemPromptIdx);
  });

  test("running the chat call-site composition produces the mutation-policy suffix", () => {
    // Reproduce the exact same options shape the chat handler uses (sans
    // the actual streamText invocation) and verify the system prompt
    // contains the mutation-policy suffix end-to-end.
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      assistantConfig: { systemPrompt: "Custom personality" },
      ontologyRegistry: ontology,
      context: {
        entity: "product",
        recordId: "p-001",
        recordData: { name: "Widget", price: 10 },
        locale: "zh-CN",
      },
      allowActionExecution: false,
    });

    expect(prompt).toContain("Mutation Policy");
    expect(prompt).toContain("NEVER claim");
    expect(prompt).toContain("CANNOT directly create");
    // And the policy is placed last
    const policyIdx = prompt.indexOf("## Mutation Policy");
    const recordIdx = prompt.indexOf("Currently viewing record ID");
    expect(policyIdx).toBeGreaterThan(recordIdx);
  });
});
