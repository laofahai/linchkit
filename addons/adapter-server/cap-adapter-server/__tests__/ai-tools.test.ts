import { describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  DataProvider,
  OntologyRegistry,
  EntityDefinition,
  EntityRegistry,
} from "@linchkit/core";
import type { EntityDescriptor } from "@linchkit/core/server";
import { buildTools } from "../src/ai/tools";

// ── Mock factories ──────────────────────────────────────

function createMockDataProvider(data: Record<string, Record<string, unknown>[]>): DataProvider {
  return {
    get: async (schema: string, id: string) => {
      const records = data[schema] ?? [];
      const found = records.find((r) => r.id === id);
      if (!found) throw new Error(`Record not found: ${schema}/${id}`);
      return found;
    },
    query: async (schema: string) => {
      return data[schema] ?? [];
    },
    create: async (_schema: string, record: Record<string, unknown>) => {
      return { id: "new-1", ...record };
    },
    update: async (_schema: string, id: string, record: Record<string, unknown>) => {
      return { id, ...record };
    },
    delete: async () => {},
    count: async (schema: string) => (data[schema] ?? []).length,
  };
}

function createMockOntologyRegistry(schemas: EntityDescriptor[]): OntologyRegistry {
  return {
    describe: (name: string) => schemas.find((s) => s.name === name),
    listEntities: () => schemas.map((s) => s.name),
    searchEntities: (query: string) =>
      schemas.filter(
        (s) => s.name.includes(query) || s.label?.includes(query) || s.description?.includes(query),
      ),
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

function createMockEntityRegistry(schemas: EntityDefinition[]): EntityRegistry {
  return {
    get: (name: string) => schemas.find((s) => s.name === name),
    getAll: () => schemas,
    has: (name: string) => schemas.some((s) => s.name === name),
  } as unknown as EntityRegistry;
}

// ── Test data ───────────────────────────────────────────

const productDescriptor: EntityDescriptor = {
  name: "product",
  label: "Product",
  description: "A product in inventory",
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
  ],
  rules: [],
  views: [],
  flows: [],
  handlers: [],
  interfaces: [],
};

const orderDescriptor: EntityDescriptor = {
  name: "order",
  label: "Order",
  description: "A sales order",
  fields: {
    amount: { type: "number", required: true, label: "Amount" },
    customer: { type: "string", required: true, label: "Customer" },
  },
  relations: [],
  actions: [],
  rules: [],
  views: [],
  flows: [],
  handlers: [],
  interfaces: [],
};

const productSchema: EntityDefinition = {
  name: "product",
  label: "Product",
  fields: {
    name: { type: "string", required: true, label: "Product Name" },
    price: { type: "number", required: true, label: "Price" },
  },
};

// ── Tool building tests ──────────────────────────────────

describe("buildTools — tool registration", () => {
  test("returns navigateTo when no context provided", () => {
    const tools = buildTools({});
    // navigateTo is always included
    expect(tools.navigateTo).toBeDefined();
  });

  test("includes queryRecords and getRecord when dataProvider is set", () => {
    const dp = createMockDataProvider({});
    const tools = buildTools({ dataProvider: dp });
    expect(tools.queryRecords).toBeDefined();
    expect(tools.getRecord).toBeDefined();
  });

  test("does NOT include queryRecords when dataProvider is missing", () => {
    const tools = buildTools({});
    expect(tools.queryRecords).toBeUndefined();
    expect(tools.getRecord).toBeUndefined();
  });

  test("includes executeAction when commandLayer is set", () => {
    const mockCl = {
      execute: async () => ({ success: true, data: {} }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: mock command layer for test
    const tools = buildTools({ commandLayer: mockCl as any });
    expect(tools.executeAction).toBeDefined();
  });

  test("does NOT include executeAction when commandLayer is missing", () => {
    const tools = buildTools({});
    expect(tools.executeAction).toBeUndefined();
  });

  test("includes describeSchema, listSchemas, searchSchemas with ontologyRegistry", () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    expect(tools.describeSchema).toBeDefined();
    expect(tools.listEntities).toBeDefined();
    expect(tools.searchEntities).toBeDefined();
  });

  test("falls back to entityRegistry describeSchema when no ontologyRegistry", () => {
    const sr = createMockEntityRegistry([productSchema]);
    const tools = buildTools({ entityRegistry: sr });
    expect(tools.describeSchema).toBeDefined();
    // listSchemas and searchSchemas are NOT available without ontology
    expect(tools.listEntities).toBeUndefined();
    expect(tools.searchEntities).toBeUndefined();
  });
});

// ── queryRecords tool ────────────────────────────────────

describe("queryRecords tool", () => {
  const sampleProducts = [
    { id: "p1", name: "Widget", price: 10 },
    { id: "p2", name: "Gadget", price: 25 },
    { id: "p3", name: "Doohickey", price: 50 },
  ];

  test("queries records from DataProvider and returns them", async () => {
    const dp = createMockDataProvider({ product: sampleProducts });
    const tools = buildTools({ dataProvider: dp });
    const result = await tools.queryRecords.execute({ schema: "product" });

    expect(result.schema).toBe("product");
    expect(result.records).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.returned).toBe(3);
  });

  test("respects limit parameter", async () => {
    const manyProducts = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `Product ${i}`,
      price: i * 10,
    }));
    const dp = createMockDataProvider({ product: manyProducts });
    const tools = buildTools({ dataProvider: dp });
    const result = await tools.queryRecords.execute({ schema: "product", limit: 5 });

    expect(result.returned).toBe(5);
    expect(result.total).toBe(20);
  });

  test("caps limit at 50", async () => {
    const lotsOfProducts = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`,
      name: `Product ${i}`,
      price: i,
    }));
    const dp = createMockDataProvider({ product: lotsOfProducts });
    const tools = buildTools({ dataProvider: dp });
    const result = await tools.queryRecords.execute({ schema: "product", limit: 200 });

    expect(result.returned).toBe(50);
    expect(result.total).toBe(100);
  });

  test("returns error object when query fails", async () => {
    const failingDp: DataProvider = {
      get: async () => {
        throw new Error("Not found");
      },
      query: async () => {
        throw new Error("Table not found");
      },
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => {},
      count: async () => 0,
    };
    const tools = buildTools({ dataProvider: failingDp });
    const result = await tools.queryRecords.execute({ schema: "nonexistent" });

    expect(result.error).toBe("Table not found");
  });
});

// ── getRecord tool ───────────────────────────────────────

describe("getRecord tool", () => {
  test("returns a single record by ID", async () => {
    const dp = createMockDataProvider({
      product: [{ id: "p1", name: "Widget", price: 10 }],
    });
    const tools = buildTools({ dataProvider: dp });
    const result = await tools.getRecord.execute({ schema: "product", id: "p1" });

    expect(result.schema).toBe("product");
    expect(result.record).toEqual({ id: "p1", name: "Widget", price: 10 });
  });

  test("returns error when record not found", async () => {
    const dp = createMockDataProvider({ product: [] });
    const tools = buildTools({ dataProvider: dp });
    const result = await tools.getRecord.execute({ schema: "product", id: "missing" });

    expect(result.error).toContain("not found");
  });
});

// ── executeAction tool ───────────────────────────────────

describe("executeAction tool", () => {
  test("executes action through CommandLayer", async () => {
    let capturedCommand: string | undefined;
    let capturedInput: Record<string, unknown> | undefined;

    const mockCl = {
      execute: async (params: { command: string; input: Record<string, unknown> }) => {
        capturedCommand = params.command;
        capturedInput = params.input;
        return { success: true, data: { id: "new-1", name: "Created" } };
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock command layer for test
    const tools = buildTools({ commandLayer: mockCl as any });
    const result = await tools.executeAction.execute({
      action: "create_product",
      input: { name: "Test Widget", price: 99 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: "new-1", name: "Created" });
    expect(capturedCommand).toBe("create_product");
    expect(capturedInput).toEqual({ name: "Test Widget", price: 99 });
  });

  test("uses default system actor when no actor provided", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock variable
    let capturedActor: any;

    const mockCl = {
      // biome-ignore lint/suspicious/noExplicitAny: test mock variable
      execute: async (params: any) => {
        capturedActor = params.actor;
        return { success: true, data: {} };
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock command layer for test
    const tools = buildTools({ commandLayer: mockCl as any });
    await tools.executeAction.execute({ action: "test_action", input: {} });

    expect(capturedActor.type).toBe("system");
    expect(capturedActor.id).toBe("ai-assistant");
  });

  test("uses provided actor when available", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock variable
    let capturedActor: any;

    const mockCl = {
      // biome-ignore lint/suspicious/noExplicitAny: test mock variable
      execute: async (params: any) => {
        capturedActor = params.actor;
        return { success: true, data: {} };
      },
    };

    const actor = { type: "user" as const, id: "user-42", groups: ["admin"] };
    // biome-ignore lint/suspicious/noExplicitAny: mock command layer for test
    const tools = buildTools({ commandLayer: mockCl as any, actor });
    await tools.executeAction.execute({ action: "test_action", input: {} });

    expect(capturedActor.id).toBe("user-42");
    expect(capturedActor.groups).toContain("admin");
  });

  test("returns error when action execution fails", async () => {
    const mockCl = {
      execute: async () => {
        throw new Error("Permission denied");
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock command layer for test
    const tools = buildTools({ commandLayer: mockCl as any });
    const result = await tools.executeAction.execute({
      action: "forbidden_action",
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Permission denied");
  });
});

// ── describeSchema tool (ontology) ───────────────────────

describe("describeSchema tool — with OntologyRegistry", () => {
  test("returns full schema descriptor", async () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    const result = await tools.describeSchema.execute({ name: "product" });

    expect(result.name).toBe("product");
    expect(result.label).toBe("Product");
    expect(result.description).toBe("A product in inventory");
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0].name).toBe("name");
    expect(result.fields[0].type).toBe("string");
    expect(result.fields[0].required).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].name).toBe("create_product");
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].targetSchema).toBe("order");
  });

  test("returns error for unknown schema", async () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    const result = await tools.describeSchema.execute({ name: "nonexistent" });

    expect(result.error).toContain("not found");
  });
});

// ── describeSchema tool (EntityRegistry fallback) ────────

describe("describeSchema tool — EntityRegistry fallback", () => {
  test("returns basic schema info from EntityRegistry", async () => {
    const sr = createMockEntityRegistry([productSchema]);
    const tools = buildTools({ entityRegistry: sr });
    const result = await tools.describeSchema.execute({ name: "product" });

    expect(result.name).toBe("product");
    expect(result.label).toBe("Product");
    expect(result.fields).toHaveLength(2);
  });

  test("returns error for unknown schema", async () => {
    const sr = createMockEntityRegistry([]);
    const tools = buildTools({ entityRegistry: sr });
    const result = await tools.describeSchema.execute({ name: "missing" });

    expect(result.error).toContain("not found");
  });
});

// ── listSchemas tool ─────────────────────────────────────

describe("listSchemas tool", () => {
  test("lists all available schemas", async () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    const result = await tools.listEntities.execute({});

    expect(result.total).toBe(2);
    expect(result.schemas).toHaveLength(2);
    expect(result.schemas[0].name).toBe("product");
    expect(result.schemas[0].fieldCount).toBe(3);
    expect(result.schemas[0].actionCount).toBe(1);
    expect(result.schemas[1].name).toBe("order");
  });
});

// ── searchSchemas tool ───────────────────────────────────

describe("searchSchemas tool", () => {
  test("searches schemas by keyword", async () => {
    const ontology = createMockOntologyRegistry([productDescriptor, orderDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    const result = await tools.searchEntities.execute({ query: "product" });

    expect(result.total).toBe(1);
    expect(result.results[0].name).toBe("product");
  });

  test("returns empty results when nothing matches", async () => {
    const ontology = createMockOntologyRegistry([productDescriptor]);
    const tools = buildTools({ ontologyRegistry: ontology });
    const result = await tools.searchEntities.execute({ query: "nonexistent_xyz" });

    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

// ── navigateTo tool ──────────────────────────────────────

describe("navigateTo tool", () => {
  test("is always included (client-side tool, no execute)", () => {
    const tools = buildTools({});
    expect(tools.navigateTo).toBeDefined();
    // navigateTo has no execute function — it's client-side rendered
  });
});
