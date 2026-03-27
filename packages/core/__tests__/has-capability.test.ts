import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Test fixtures ───────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

function createMemoryDataProvider(): DataProvider {
  const store: Record<string, Record<string, Record<string, unknown>>> = {};
  return {
    get: async (schema, id) => {
      const record = store[schema]?.[id];
      if (!record) throw new Error(`Not found: ${schema}/${id}`);
      return record;
    },
    query: async (schema) => Object.values(store[schema] ?? {}),
    create: async (schema, data) => {
      const id = data.id as string ?? `id-${Date.now()}`;
      if (!store[schema]) store[schema] = {};
      const record = { ...data, id };
      store[schema][id] = record;
      return record;
    },
    update: async (schema, id, data) => {
      store[schema][id] = { ...store[schema][id], ...data };
      return store[schema][id];
    },
    delete: async (schema, id) => {
      delete store[schema]?.[id];
    },
    count: async (schema) => Object.keys(store[schema] ?? {}).length,
  };
}

// ── Tests ───────────────────────────────────────────────

describe("ActionContext.hasCapability", () => {
  it("returns true for registered capability names", async () => {
    const dataProvider = createMemoryDataProvider();
    const capabilityNames = new Set(["cap-auth", "cap-purchase-demo"]);
    const executor = createActionExecutor({ dataProvider, capabilityNames });

    let capturedResult: boolean | undefined;

    const action: ActionDefinition = {
      name: "test_has_capability",
      schema: "test",
      label: "Test hasCapability",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        capturedResult = ctx.hasCapability("cap-auth");
        return { checked: true };
      },
    };
    executor.registry.register(action);

    const result = await executor.execute("test_has_capability", {}, defaultActor);
    expect(result.success).toBe(true);
    expect(capturedResult).toBe(true);
  });

  it("returns false for unregistered capability names", async () => {
    const dataProvider = createMemoryDataProvider();
    const capabilityNames = new Set(["cap-auth"]);
    const executor = createActionExecutor({ dataProvider, capabilityNames });

    let capturedResult: boolean | undefined;

    const action: ActionDefinition = {
      name: "test_missing_capability",
      schema: "test",
      label: "Test missing capability",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        capturedResult = ctx.hasCapability("cap-nonexistent");
        return { checked: true };
      },
    };
    executor.registry.register(action);

    const result = await executor.execute("test_missing_capability", {}, defaultActor);
    expect(result.success).toBe(true);
    expect(capturedResult).toBe(false);
  });

  it("returns false when no capabilities are registered", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });

    let capturedResult: boolean | undefined;

    const action: ActionDefinition = {
      name: "test_no_capabilities",
      schema: "test",
      label: "Test no capabilities",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        capturedResult = ctx.hasCapability("anything");
        return { checked: true };
      },
    };
    executor.registry.register(action);

    const result = await executor.execute("test_no_capabilities", {}, defaultActor);
    expect(result.success).toBe(true);
    expect(capturedResult).toBe(false);
  });
});
