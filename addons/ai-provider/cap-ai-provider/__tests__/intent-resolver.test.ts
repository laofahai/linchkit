/**
 * Tests for resolveIntent (Spec 52 Phase 0 PoC)
 *
 * All tests use a deterministic fake AiService that returns canned
 * responses — no real LLM calls. Coverage matches the PoC checklist:
 *  1. Happy path — valid match returns a populated ActionProposal.
 *  2. AI proposes an unknown action → null.
 *  3. AI proposes input fields that don't exist on the action → dropped;
 *     required-but-missing fields surface in `missingFields`.
 *  4. Malformed JSON → null without throwing.
 *  5. Confidence below MIN_CONFIDENCE → null.
 *  6. scope.actionFilter excludes actions even if AI proposes them → null.
 *  7. Empty / whitespace prompt → null.
 *
 * Plus a few extra edge cases that fall out of the contract for free:
 *  - Markdown-fenced JSON is parsed.
 *  - AI throwing is treated as graceful degradation, not a crash.
 *  - scope.entityFilter narrows the catalog presented to the AI.
 */

import { describe, expect, it } from "bun:test";
import type {
  ActionDefinition,
  AICompletionOptions,
  AICompletionResult,
  AIService,
} from "@linchkit/core";
import { MIN_CONFIDENCE, type OntologyRegistryLike, resolveIntent } from "../src/intent-resolver";

// ── Fixture actions ─────────────────────────────────────────

const createPurchaseRequest: ActionDefinition = {
  name: "create_purchase_request",
  entity: "purchase_request",
  label: "Create Purchase Request",
  description: "Create a new purchase request",
  input: {
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", required: true, label: "Department" },
    description: { type: "text", required: false, label: "Description" },
  },
  policy: { mode: "sync", transaction: true },
};

const submitPurchaseRequest: ActionDefinition = {
  name: "submit_purchase_request",
  entity: "purchase_request",
  label: "Submit Purchase Request",
  input: {
    id: { type: "string", required: true, label: "Request ID" },
  },
  policy: { mode: "sync", transaction: true },
};

const createVendor: ActionDefinition = {
  name: "create_vendor",
  entity: "vendor",
  label: "Create Vendor",
  input: {
    name: { type: "string", required: true, label: "Vendor Name" },
  },
  policy: { mode: "sync", transaction: true },
};

// ── Test helpers ────────────────────────────────────────────

function makeOntology(): OntologyRegistryLike {
  const byEntity: Record<string, ActionDefinition[]> = {
    purchase_request: [createPurchaseRequest, submitPurchaseRequest],
    vendor: [createVendor],
  };
  return {
    listEntities: () => Object.keys(byEntity),
    actionsFor: (entity) => byEntity[entity] ?? [],
  };
}

interface CallRecord {
  options: AICompletionOptions;
}

interface FakeAi {
  service: AIService;
  calls: CallRecord[];
}

function makeFakeAi(content: string | (() => string | Promise<string>)): FakeAi {
  const calls: CallRecord[] = [];
  const service: AIService = {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async (options) => {
      calls.push({ options });
      const resolved = typeof content === "function" ? await content() : content;
      const result: AICompletionResult = {
        content: resolved,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "fake-model",
        provider: "fake",
        duration: 0,
      };
      return result;
    },
  };
  return { service, calls };
}

function makeThrowingAi(error: Error = new Error("AI exploded")): FakeAi {
  const calls: CallRecord[] = [];
  const service: AIService = {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async (options) => {
      calls.push({ options });
      throw error;
    },
  };
  return { service, calls };
}

// ── Tests ───────────────────────────────────────────────────

describe("resolveIntent — happy path", () => {
  it("returns an ActionProposal when the AI matches a known action", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_purchase_request",
        input: { amount: 5000, department: "综合管理部", description: "Office chairs" },
        confidence: 0.92,
        explanation: "Creating a ¥5,000 purchase request for 综合管理部.",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Create a 5000 yuan purchase request for 综合管理部 for office chairs" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).not.toBeNull();
    expect(proposal?.action).toBe("create_purchase_request");
    expect(proposal?.input).toEqual({
      amount: 5000,
      department: "综合管理部",
      description: "Office chairs",
    });
    expect(proposal?.confidence).toBe(0.92);
    expect(proposal?.missingFields).toEqual([]);
    expect(proposal?.explanation.length).toBeGreaterThan(0);
  });

  it("forwards tenant id to the AI service for BYOK config", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_vendor",
        input: { name: "Acme" },
        confidence: 0.8,
        explanation: "Create vendor Acme",
      }),
    );

    await resolveIntent(
      { prompt: "Add vendor Acme", tenant: "tenant-a" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.options.tenantId).toBe("tenant-a");
  });

  it("parses JSON wrapped in Markdown code fences", async () => {
    const ai = makeFakeAi(
      "```json\n" +
        JSON.stringify({
          action: "create_vendor",
          input: { name: "Acme" },
          confidence: 0.85,
          explanation: "Create vendor Acme",
        }) +
        "\n```",
    );

    const proposal = await resolveIntent(
      { prompt: "Create vendor Acme" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal?.action).toBe("create_vendor");
    expect(proposal?.input).toEqual({ name: "Acme" });
  });
});

describe("resolveIntent — refusal & null cases", () => {
  it("returns null for an empty prompt without calling AI", async () => {
    const ai = makeFakeAi("{}");
    const proposal = await resolveIntent(
      { prompt: "   " },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
    expect(ai.calls).toHaveLength(0);
  });

  it("returns null when AI proposes an action that is not in the ontology", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "delete_universe",
        input: {},
        confidence: 0.95,
        explanation: "Boom.",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Delete the universe" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
  });

  it("returns null when AI returns malformed JSON (no throw)", async () => {
    const ai = makeFakeAi("definitely not json {{{ ::: }");
    const proposal = await resolveIntent(
      { prompt: "Create something" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
  });

  it("returns null when confidence is below MIN_CONFIDENCE", async () => {
    expect(MIN_CONFIDENCE).toBeGreaterThan(0);
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_purchase_request",
        input: { amount: 5000, department: "IT" },
        confidence: MIN_CONFIDENCE - 0.1,
        explanation: "I'm not sure",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Maybe create something" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
  });

  it("returns null when the action is explicitly excluded by actionFilter", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_purchase_request",
        input: { amount: 5000, department: "IT" },
        confidence: 0.9,
        explanation: "Create purchase request",
      }),
    );

    const proposal = await resolveIntent(
      {
        prompt: "Create a 5000 yuan purchase request for IT",
        scope: { actionFilter: ["submit_purchase_request"] },
      },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
  });

  it("returns null when the AI service throws (graceful degradation)", async () => {
    const ai = makeThrowingAi();
    const proposal = await resolveIntent(
      { prompt: "Create a vendor" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
    expect(ai.calls).toHaveLength(1);
  });

  it("returns null when AI explicitly refuses (action: null)", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: null,
        input: {},
        confidence: 0.0,
        explanation: "I don't understand the request.",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Make me a sandwich" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
  });

  it("returns null when no actions remain after scope filtering", async () => {
    const ai = makeFakeAi("{}");
    const proposal = await resolveIntent(
      {
        prompt: "Anything",
        scope: { entityFilter: ["does_not_exist"] },
      },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).toBeNull();
    // No catalog → no AI call.
    expect(ai.calls).toHaveLength(0);
  });
});

describe("resolveIntent — input reconciliation", () => {
  it("drops AI-invented input fields and surfaces missing required fields", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_purchase_request",
        input: {
          amount: 5000,
          // department deliberately missing — required
          description: "Furniture",
          // bogus_field is invented by the AI and must be dropped
          bogus_field: "nope",
        },
        confidence: 0.8,
        explanation: "Create a ¥5,000 purchase request",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Create a 5000 yuan purchase request" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal).not.toBeNull();
    expect(proposal?.input).toEqual({ amount: 5000, description: "Furniture" });
    expect(proposal?.missingFields).toEqual(["department"]);
    expect(Object.keys(proposal?.input ?? {})).not.toContain("bogus_field");
  });

  it("treats null and empty string as missing for required fields", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_purchase_request",
        input: { amount: null, department: "" },
        confidence: 0.7,
        explanation: "Partial",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Make a purchase request" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal?.missingFields).toEqual(["amount", "department"]);
  });

  it("clamps out-of-range confidence values into [0, 1]", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_vendor",
        input: { name: "Acme" },
        confidence: 1.7,
        explanation: "Create vendor",
      }),
    );

    const proposal = await resolveIntent(
      { prompt: "Add vendor Acme" },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal?.confidence).toBe(1);
  });
});

describe("resolveIntent — scope filtering", () => {
  it("entityFilter narrows the catalog passed to the AI", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "create_vendor",
        input: { name: "Acme" },
        confidence: 0.9,
        explanation: "Create vendor",
      }),
    );

    await resolveIntent(
      { prompt: "Add vendor Acme", scope: { entityFilter: ["vendor"] } },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(ai.calls).toHaveLength(1);
    const systemMessage = ai.calls[0]?.options.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("create_vendor");
    expect(systemMessage?.content).not.toContain("create_purchase_request");
    expect(systemMessage?.content).not.toContain("submit_purchase_request");
  });

  it("actionFilter is honored even when entityFilter is omitted", async () => {
    const ai = makeFakeAi(
      JSON.stringify({
        action: "submit_purchase_request",
        input: { id: "pr-123" },
        confidence: 0.85,
        explanation: "Submit pr-123",
      }),
    );

    const proposal = await resolveIntent(
      {
        prompt: "Submit pr-123",
        scope: { actionFilter: ["submit_purchase_request"] },
      },
      { ai: ai.service, ontology: makeOntology() },
    );

    expect(proposal?.action).toBe("submit_purchase_request");
    const systemMessage = ai.calls[0]?.options.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("submit_purchase_request");
    expect(systemMessage?.content).not.toContain("create_purchase_request");
    expect(systemMessage?.content).not.toContain("create_vendor");
  });
});
