import { describe, expect, test } from "bun:test";
import type { ActionDefinition, OntologyRegistry, EntityDefinition } from "@linchkit/core";
import type { EntityDescriptor } from "@linchkit/core/server";
import { buildSystemPrompt } from "../src/ai/system-prompt";

// ── Mock factories ──────────────────────────────────────

function createMockOntologyRegistry(schemas: EntityDescriptor[]): OntologyRegistry {
  return {
    describe: (name: string) => schemas.find((s) => s.name === name),
    listSchemas: () => schemas.map((s) => s.name),
    searchSchemas: () => [],
    actionsFor: () => [],
    rulesFor: () => [],
    stateFor: () => undefined,
    viewsFor: () => [],
    flowsFor: () => [],
    handlersFor: () => [],
    relatedSchemas: () => [],
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
      linkName: "product_orders",
      label: "Orders",
      targetSchema: "order",
      cardinality: "one_to_many" as const,
    },
  ],
  actions: [
    {
      name: "create_product",
      label: "Create Product",
      schema: "product",
      policy: "unrestricted",
    } as ActionDefinition,
    {
      name: "update_price",
      label: "Update Price",
      schema: "product",
      policy: "unrestricted",
    } as ActionDefinition,
  ],
  rules: [],
  states: {
    schema: "product",
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

    expect(prompt).toContain("Available Schemas");
    expect(prompt).toContain("2 schema(s)");
    expect(prompt).toContain("product");
    expect(prompt).toContain("order");
  });

  test("omits schema section when no ontology provided", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain("Available Schemas");
  });
});

describe("buildSystemPrompt — current schema context", () => {
  test("includes detailed schema info when context.schema is set", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: { schema: "product" },
    });

    expect(prompt).toContain("Current Schema Context");
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
      context: { schema: "product" },
    });

    expect(prompt).toContain("Current Schema Context");
    expect(prompt).toContain("product (Product)");
    expect(prompt).toContain("name, price");
  });

  test("includes record ID when viewing a specific record", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: { schema: "product", recordId: "rec-abc-123" },
    });

    expect(prompt).toContain("Currently viewing record ID: rec-abc-123");
  });

  test("includes record data (JSON) when provided", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const prompt = buildSystemPrompt({
      ontologyRegistry: ontology,
      context: {
        schema: "product",
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
        schema: "product",
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
      context: { schema: "nonexistent" },
    });

    // Should not throw, and should not include schema context
    expect(prompt).not.toContain("Current Schema Context");
  });
});

describe("buildSystemPrompt — combined options", () => {
  test("builds a complete prompt with all sections", () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const prompt = buildSystemPrompt({
      assistantConfig: { systemPrompt: "You are a product catalog assistant." },
      ontologyRegistry: ontology,
      context: {
        schema: "product",
        recordId: "p-001",
        recordData: { name: "Laptop", price: 999 },
      },
    });

    // Custom system prompt
    expect(prompt).toContain("product catalog assistant");
    // Schema overview
    expect(prompt).toContain("2 schema(s)");
    // Current schema context
    expect(prompt).toContain("Current Schema Context");
    // Record context
    expect(prompt).toContain("p-001");
    expect(prompt).toContain("Laptop");
  });
});
