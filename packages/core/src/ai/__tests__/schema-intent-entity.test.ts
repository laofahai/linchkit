/**
 * Tests for the entity-creation slice of resolveSchemaIntent (issue #575).
 *
 * Drives the resolver with a deterministic FAKE AIService returning canned JSON,
 * wired to a REAL ProposalEngine (no mock-masking — the proposal path exercises
 * the genuine engine and asserts the resulting governed draft).
 *
 * The exemplar utterance is the real 2026-06-11 walkthrough request:
 *   "增加一个商品管理。让采购明细可以直接选择。目前以办公用品为主。要支持箱规、商品分类、规格、条码等。"
 * → a new `product` entity (category / specification / barcode / case_pack_quantity)
 *   PLUS a `purchase_item → product` many_to_one relation.
 *
 * Coverage:
 *  - add_entity path → a draft-status `modify_schema` Proposal (diff.target=entity)
 *    whose definition carries the product fields + the relation.
 *  - "Never applies" guarantee → status stays `draft`.
 *  - System-field collision is rejected (id/tenant_id/... cannot be declared).
 *  - Relation endpoint validation (from must exist; to must be the new entity).
 *  - Multi-intent → clarification with detectedIntents (never silent no_match).
 *  - Low confidence demotes to clarification.
 *  - The existing add_rule path is unaffected (smoke).
 */

import { describe, expect, it } from "bun:test";
import type { AICompletionOptions, AICompletionResult, AIService } from "../../types/ai";
import { ProposalEngine } from "../proposal-engine";
import { buildEntityDefinition } from "../schema-intent-entity-builder";
import { resolveSchemaIntent } from "../schema-intent-resolver";
import type { SchemaIntentOntology } from "../schema-intent-types";

// ── Ontology fixture (includes purchase_item for the relation `from`) ──

function makeOntology(): SchemaIntentOntology {
  const purchaseItem = {
    name: "purchase_item",
    label: "Purchase Item",
    description: "A line item on a purchase request",
    fields: [
      { name: "quantity", type: "number", required: true, label: "Quantity" },
      { name: "unit_price", type: "number", required: false, label: "Unit Price" },
    ],
    actionNames: ["create_purchase_item"],
  };
  const byName: Record<string, typeof purchaseItem> = { purchase_item: purchaseItem };
  return {
    listEntities: () => Object.keys(byName),
    describeEntity: (name) => byName[name],
  };
}

/** A fresh, zero-entity deployment — the 说→有 first-entity case. */
function makeEmptyOntology(): SchemaIntentOntology {
  return {
    listEntities: () => [],
    describeEntity: () => undefined,
  };
}

// ── Fake AIService (dependency injection — no global reassignment) ──

function makeFakeAi(content: string): { service: AIService; calls: AICompletionOptions[] } {
  const calls: AICompletionOptions[] = [];
  const service: AIService = {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async (options) => {
      calls.push(options);
      const result: AICompletionResult = {
        content,
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

// The structured add_entity draft the LLM is expected to emit for the exemplar.
const exemplarEntityResponse = JSON.stringify({
  kind: "add_entity",
  entity: {
    name: "product",
    label: "商品",
    description: "A product that can be selected on a purchase line item",
    fields: [
      {
        name: "category",
        type: "enum",
        required: true,
        label: "商品分类",
        options: ["office_supply"],
      },
      { name: "specification", type: "text", required: false, label: "规格" },
      { name: "barcode", type: "string", required: false, label: "条码", unique: true },
      { name: "case_pack_quantity", type: "number", required: false, label: "箱规", min: 1 },
    ],
  },
  relation: {
    name: "purchase_item_product",
    from: "purchase_item",
    to: "product",
    cardinality: "many_to_one",
    fromName: "product",
    toName: "purchase_items",
  },
  confidence: 0.9,
  explanation: "新增商品实体并让采购明细可以选择商品。",
});

// ── add_entity (happy path / exemplar) ───────────────────────

describe("resolveSchemaIntent — add_entity proposal draft (exemplar #575)", () => {
  it("drafts a governed add_entity Proposal with the product fields + relation", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(exemplarEntityResponse);

    const outcome = await resolveSchemaIntent(
      {
        utterance: "增加一个商品管理。让采购明细可以直接选择。要支持箱规、商品分类、规格、条码等。",
      },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );

    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");

    // Entity name is product-like (snake_case singular).
    expect(outcome.entityName).toBe("product");

    // Fields include the four mapped Chinese requirements.
    const fieldNames = outcome.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(
      ["barcode", "case_pack_quantity", "category", "specification"].sort(),
    );
    const category = outcome.fields.find((f) => f.name === "category");
    expect(category?.type).toBe("enum");
    expect(category?.options).toEqual(["office_supply"]);
    const barcode = outcome.fields.find((f) => f.name === "barcode");
    expect(barcode?.unique).toBe(true);
    const casePack = outcome.fields.find((f) => f.name === "case_pack_quantity");
    expect(casePack?.type).toBe("number");
    expect(casePack?.min).toBe(1);

    // The relation purchase_item → product many_to_one.
    expect(outcome.relation).toBeDefined();
    expect(outcome.relation?.from).toBe("purchase_item");
    expect(outcome.relation?.to).toBe("product");
    expect(outcome.relation?.cardinality).toBe("many_to_one");

    // The Proposal is GOVERNED and draft (never auto-applied).
    const p = outcome.proposal;
    expect(p.type).toBe("modify_schema");
    expect(p.status).toBe("draft");
    expect(p.diff.target).toBe("entity");
    expect(p.diff.operation).toBe("create");

    // The definition carries the entity + the relation for the code generator.
    const def = p.diff.definition as Record<string, unknown>;
    expect(def.name).toBe("product");
    expect(def.fields).toBeDefined();
    expect((def.fields as Record<string, unknown>).barcode).toBeDefined();
    expect(def.relation).toBeDefined();

    // Queryable through the real engine; only one draft, nothing advanced.
    expect(engine.size).toBe(1);
    expect(engine.get(p.id)?.status).toBe("draft");
    expect(engine.list("pending").length).toBe(0);
    expect(engine.list("applied").length).toBe(0);
  });

  it("defaults relation fromName/toName/name when the AI omits them", async () => {
    // The AI emits a relation with only from/to/cardinality — no semantic names.
    // `normalizeRuleName` returns `undefined` (NOT "") for the omitted fields, so
    // the `?? default` fallbacks fire: fromName = to, toName = `${from}s`,
    // name = `${from}_${to}`. (Guards against a regression where the helper would
    // return "" and silently defeat the nullish fallbacks.)
    const responseWithBareRelation = JSON.stringify({
      kind: "add_entity",
      entity: {
        name: "product",
        fields: [{ name: "barcode", type: "string", required: false, label: "条码", unique: true }],
      },
      relation: { from: "purchase_item", to: "product", cardinality: "many_to_one" },
      confidence: 0.9,
      explanation: "默认命名。",
    });
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(responseWithBareRelation);

    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品管理，采购明细可以选择。" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );

    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.relation?.fromName).toBe("product");
    expect(outcome.relation?.toName).toBe("purchase_items");
    expect(outcome.relation?.name).toBe("purchase_item_product");
  });

  it("never auto-submits or applies — engine stays at draft only", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(exemplarEntityResponse);
    await resolveSchemaIntent(
      { utterance: "增加一个商品管理，支持商品分类。" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(engine.list("pending")).toEqual([]);
    expect(engine.list("approved")).toEqual([]);
    expect(engine.list("applied")).toEqual([]);
    expect(engine.list().every((p) => p.status === "draft")).toBe(true);
  });

  it("drafts an entity with no relation when none is proposed", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: {
          name: "supplier",
          label: "Supplier",
          fields: [{ name: "name", type: "string", required: true }],
        },
        confidence: 0.85,
        explanation: "Add a supplier entity.",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "Create a supplier entity with a name." },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.entityName).toBe("supplier");
    expect(outcome.relation).toBeUndefined();
    const def = outcome.proposal.diff.definition as Record<string, unknown>;
    expect(def.relation).toBeUndefined();
  });
});

// ── Empty catalog: add_entity must work on a fresh deployment ─

describe("resolveSchemaIntent — add_entity on an empty catalog (说→有 first entity)", () => {
  const firstEntityResponse = JSON.stringify({
    kind: "add_entity",
    entity: {
      name: "product",
      fields: [{ name: "barcode", type: "string", required: false, label: "条码", unique: true }],
    },
    confidence: 0.9,
    explanation: "第一个实体。",
  });

  it("drafts the first entity instead of returning no_entities_in_scope", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(firstEntityResponse);
    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品管理" },
      { provider: service, ontology: makeEmptyOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.entityName).toBe("product");
    expect(engine.size).toBe(1);
  });

  it("still rejects an add_rule on an empty catalog (guard moved, not removed)", async () => {
    const ruleResponse = JSON.stringify({
      kind: "add_rule",
      targetEntity: "product",
      rule: { name: "r", condition: {}, effect: {} },
      confidence: 0.9,
      explanation: "x",
    });
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(ruleResponse);
    const outcome = await resolveSchemaIntent(
      { utterance: "当金额大于100时拦截" },
      { provider: service, ontology: makeEmptyOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("no_entities_in_scope");
    expect(engine.size).toBe(0);
  });
});

// ── Validation: system fields / relation endpoints ───────────

describe("resolveSchemaIntent — add_entity validation", () => {
  it("asks an entity-specific clarification (not the rule one) on low confidence", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        confidence: 0.2,
        explanation: "unsure",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "搞个商品什么的" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification");
    // The add_entity path must not fall back to the rule-oriented wording.
    expect(outcome.question).not.toMatch(/rule|condition/i);
    expect(outcome.question.toLowerCase()).toContain("create");
    expect(engine.size).toBe(0);
  });

  it("rejects a number field whose min is greater than max", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: {
          name: "product",
          fields: [{ name: "qty", type: "number", required: false, min: 100, max: 1 }],
        },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "create product with a bad numeric bound" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("invalid_entity");
    expect(engine.size).toBe(0);
  });

  it("pluralizes the default relation toName correctly (category → categories)", async () => {
    const categoryOntology: SchemaIntentOntology = {
      listEntities: () => ["category"],
      describeEntity: (n) =>
        n === "category"
          ? { name: "category", label: "Category", description: "", fields: [], actionNames: [] }
          : undefined,
    };
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        // Relation from an existing `category` entity, no explicit toName — the
        // builder must default it to the correct plural, not "categorys".
        relation: { from: "category", to: "product", cardinality: "many_to_one" },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品，按分类组织" },
      { provider: service, ontology: categoryOntology, proposalEngine: new ProposalEngine() },
    );
    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.relation?.toName).toBe("categories");
  });

  it("rejects a PARTIAL relation payload (keys present but `from` missing) instead of dropping it", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        // The user asked for a relation but the AI omitted `from` — this must
        // surface as invalid_entity, NOT silently draft the entity without it.
        relation: { to: "product", cardinality: "many_to_one" },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品，采购明细可选" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("invalid_entity");
    expect(outcome.message).toContain("relation.from");
    expect(engine.size).toBe(0);
  });

  it("rejects non-finite numeric bounds (direct builder call — JSON cannot carry NaN)", () => {
    const result = buildEntityDefinition(
      {
        name: "product",
        fields: [{ name: "qty", type: "number", required: false, min: Number.NaN }],
      } as Parameters<typeof buildEntityDefinition>[0],
      undefined,
      makeOntology(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toContain("non-finite min");

    const inf = buildEntityDefinition(
      {
        name: "product",
        fields: [{ name: "qty", type: "number", required: false, max: Number.POSITIVE_INFINITY }],
      } as Parameters<typeof buildEntityDefinition>[0],
      undefined,
      makeOntology(),
    );
    expect(inf.ok).toBe(false);
    if (inf.ok) throw new Error("expected failure");
    expect(inf.reason).toContain("non-finite max");
  });

  it("defaults navigation names per cardinality (one_to_many: collection on the from side)", async () => {
    // department (existing) → employee (new), one_to_many: one department has
    // many employees → department.employees (plural) / employee.department (singular).
    const deptOntology: SchemaIntentOntology = {
      listEntities: () => ["department"],
      describeEntity: (n) =>
        n === "department"
          ? {
              name: "department",
              label: "Department",
              description: "",
              fields: [],
              actionNames: [],
            }
          : undefined,
    };
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "employee", fields: [{ name: "title", type: "string", required: false }] },
        relation: { from: "department", to: "employee", cardinality: "one_to_many" },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "增加员工，按部门组织" },
      { provider: service, ontology: deptOntology, proposalEngine: new ProposalEngine() },
    );
    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.relation?.fromName).toBe("employees");
    expect(outcome.relation?.toName).toBe("department");
  });

  it("treats an empty `relation: {}` placeholder as absent, not a hard failure", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        // LLMs sometimes emit `{}` instead of omitting the key — must not kill
        // the otherwise-valid entity draft.
        relation: {},
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("entity_proposal_draft");
    if (outcome.kind !== "entity_proposal_draft") throw new Error("expected entity_proposal_draft");
    expect(outcome.relation).toBeUndefined();
    expect(engine.size).toBe(1);
  });

  it("rejects an entity declaring a server-managed system field", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: {
          name: "product",
          fields: [
            { name: "tenant_id", type: "string", required: true },
            { name: "barcode", type: "string", required: false },
          ],
        },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "create product with tenant_id" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("invalid_entity");
    expect(outcome.message).toContain("tenant_id");
    expect(engine.size).toBe(0);
  });

  it("rejects a relation whose `from` is not an existing entity", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        relation: {
          name: "ghost_product",
          from: "ghost_entity",
          to: "product",
          cardinality: "many_to_one",
          fromName: "product",
          toName: "ghosts",
        },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "create product linked from a ghost" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("invalid_entity");
    expect(engine.size).toBe(0);
  });

  it("rejects re-declaring an existing entity", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: {
          name: "purchase_item",
          fields: [{ name: "foo", type: "string", required: false }],
        },
        confidence: 0.9,
        explanation: "x",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "create purchase_item again" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind !== "no_match") throw new Error("expected no_match");
    expect(outcome.reason).toBe("invalid_entity");
    expect(engine.size).toBe(0);
  });

  it("demotes a low-confidence add_entity to clarification (no draft minted)", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_entity",
        entity: { name: "product", fields: [{ name: "barcode", type: "string", required: false }] },
        confidence: 0.1,
        explanation: "unsure",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "maybe a product?" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("clarification");
    expect(engine.size).toBe(0);
  });
});

// ── Multi-intent guard ───────────────────────────────────────

describe("resolveSchemaIntent — multi-intent clarification (#575)", () => {
  it("returns clarification with detectedIntents instead of a silent no_match", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "clarification",
        question:
          "Should I draft the product entity first? The 'office supplies only' rule is a follow-up.",
        detectedIntents: ["add_entity", "add_rule"],
        confidence: 0.6,
      }),
    );
    const outcome = await resolveSchemaIntent(
      {
        utterance: "增加一个商品管理。目前以办公用品为主。", // entity + rule-ish constraint
      },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification");
    expect(outcome.detectedIntents).toEqual(["add_entity", "add_rule"]);
    expect(outcome.question.length).toBeGreaterThan(0);
    // Not a silent drop — and nothing minted.
    expect(engine.size).toBe(0);
  });

  it("supplies a default multi-intent question when the AI omits one", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "clarification",
        detectedIntents: ["add_entity", "add_rule"],
        confidence: 0.5,
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "增加一个商品管理，且金额超过1000要审批。" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification");
    expect(outcome.detectedIntents).toEqual(["add_entity", "add_rule"]);
    expect(outcome.question).toContain("new entity");
  });

  it("uses the entity-specific fallback when AI omits the question for a sole add_entity intent", async () => {
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "clarification",
        detectedIntents: ["add_entity"],
        confidence: 0.3,
        // no `question` — the resolver must pick the fallback by intent
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "搞个商品" },
      { provider: service, ontology: makeOntology(), proposalEngine: new ProposalEngine() },
    );
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification");
    expect(outcome.question).not.toMatch(/rule|condition/i);
    expect(outcome.question.toLowerCase()).toContain("create");
  });
});

// ── add_rule regression smoke ────────────────────────────────

describe("resolveSchemaIntent — add_rule still works (no regression)", () => {
  it("drafts an add_rule against an existing entity", async () => {
    const engine = new ProposalEngine();
    const { service } = makeFakeAi(
      JSON.stringify({
        kind: "add_rule",
        targetEntity: "purchase_item",
        rule: {
          name: "block_zero_quantity",
          label: "Block zero quantity",
          trigger: { action: "create_purchase_item" },
          condition: { field: "quantity", operator: "lt", value: 1 },
          effect: { type: "block", message: "Quantity must be at least 1" },
        },
        confidence: 0.9,
        explanation: "Block zero-quantity line items.",
      }),
    );
    const outcome = await resolveSchemaIntent(
      { utterance: "block purchase items with quantity below 1" },
      { provider: service, ontology: makeOntology(), proposalEngine: engine },
    );
    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    expect(outcome.ruleName).toBe("block_zero_quantity");
    expect(outcome.proposal.type).toBe("add_rule");
    expect(outcome.proposal.status).toBe("draft");
    expect(outcome.proposal.diff.target).toBe("rule");
  });
});
