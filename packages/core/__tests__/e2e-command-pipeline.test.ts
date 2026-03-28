/**
 * E2E Test: Full 7-slot CommandLayer pipeline
 *
 * Verifies the complete middleware pipeline: pre -> auth -> exposure -> permission ->
 * tenant -> pre-action -> post-action, end-to-end with real ActionEngine and DataProvider.
 *
 * Covers:
 * - Each slot receives and can modify context
 * - Slot can reject (throw) to halt pipeline
 * - Multiple middlewares in same slot execute in order
 * - Integration with action execution end-to-end
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { type CommandLayer, PipelineError, createCommandLayer } from "../src/engine/command-layer";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Minimal in-memory data provider ───────────────────────────

function createMemoryDataProvider() {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  return {
    async get(schema: string, id: string) {
      const record = store.get(schema)?.get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return record;
    },
    async query(_schema: string, _filter: Record<string, unknown>) {
      return [];
    },
    async create(schema: string, input: Record<string, unknown>) {
      if (!store.has(schema)) store.set(schema, new Map());
      counter++;
      const id = `id_${counter}`;
      const record = { id, ...input, _version: 1, tenant_id: null };
      store.get(schema)?.set(id, record);
      return record;
    },
    async update(schema: string, id: string, updates: Record<string, unknown>) {
      const record = store.get(schema)?.get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      Object.assign(record, updates);
      return record;
    },
    async delete(schema: string, id: string) {
      store.get(schema)?.delete(id);
    },
  };
}

// ── Test setup ────────────────────────────────────────────────

type SlotName = "pre" | "auth" | "permission" | "tenant" | "pre-action" | "post-action";

function createTestSetup() {
  const dp = createMemoryDataProvider();
  const executor = createActionExecutor({ dataProvider: dp });

  const echoAction: ActionDefinition = {
    name: "echo",
    schema: "item",
    label: "Echo",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      return { echoed: ctx.input.message };
    },
  };

  const createAction: ActionDefinition = {
    name: "create_item",
    schema: "item",
    label: "Create Item",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      return ctx.create("item", ctx.input);
    },
  };

  executor.registry.register(echoAction);
  executor.registry.register(createAction);

  const layer = createCommandLayer({ executor });
  return { executor, layer, dp };
}

// ── Tests ──────────────────────────────────────────────────────

describe("E2E: CommandLayer 7-slot pipeline", () => {
  let layer: CommandLayer;
  let _executor: ReturnType<typeof createActionExecutor>;

  beforeEach(() => {
    const setup = createTestSetup();
    layer = setup.layer;
    _executor = setup.executor;
  });

  describe("Each pipeline slot executes in order", () => {
    it("registerable slots run in correct sequence (exposure is built-in)", async () => {
      const slotOrder: string[] = [];
      // Note: "exposure" slot is built-in and cannot accept registered middleware
      const registerableSlots: SlotName[] = [
        "pre",
        "auth",
        "permission",
        "tenant",
        "pre-action",
        "post-action",
      ];

      for (const slot of registerableSlots) {
        layer.use({
          name: `capture-${slot}`,
          slot,
          handler: async (_ctx, next) => {
            slotOrder.push(slot);
            await next();
          },
        });
      }

      await layer.execute({ command: "echo", input: { message: "hello" } });

      expect(slotOrder).toEqual(registerableSlots);
    });
  });

  describe("Context modification by slot", () => {
    it("auth slot can set actor, visible in subsequent slots", async () => {
      let actorInPreAction: Actor | undefined;

      layer.use({
        name: "set-actor",
        slot: "auth",
        handler: async (ctx, next) => {
          ctx.actor = { type: "human", id: "user-42", name: "Alice", groups: ["admin"] };
          await next();
        },
      });

      layer.use({
        name: "read-actor",
        slot: "pre-action",
        handler: async (ctx, next) => {
          actorInPreAction = ctx.actor;
          await next();
        },
      });

      await layer.execute({ command: "echo", input: { message: "x" } });

      expect(actorInPreAction?.id).toBe("user-42");
      expect(actorInPreAction?.groups).toContain("admin");
    });

    it("pre-action slot can enrich input before action executes", async () => {
      layer.use({
        name: "enrich-input",
        slot: "pre-action",
        handler: async (ctx, next) => {
          ctx.input.enriched = true;
          ctx.input.source = "pipeline";
          await next();
        },
      });

      const result = await layer.execute({ command: "create_item", input: { name: "thing" } });

      expect(result.success).toBe(true);
      const record = result.data as Record<string, unknown>;
      expect(record.enriched).toBe(true);
      expect(record.source).toBe("pipeline");
    });

    it("post-action slot can read action result via ctx.result.data", async () => {
      let capturedData: unknown;

      layer.use({
        name: "capture-result",
        slot: "post-action",
        handler: async (ctx, _next) => {
          // ctx.result is set before post-action runs; next() is a no-op here
          capturedData = (ctx.result as { data: unknown } | undefined)?.data;
        },
      });

      await layer.execute({ command: "echo", input: { message: "test-result" } });

      expect(capturedData).toBeDefined();
      expect((capturedData as Record<string, unknown>).echoed).toBe("test-result");
    });
  });

  describe("Slot rejection halts pipeline", () => {
    it("auth slot throwing halts pipeline; action does not execute", async () => {
      let actionExecuted = false;

      const dp = createMemoryDataProvider();
      const exec = createActionExecutor({ dataProvider: dp });
      exec.registry.register({
        name: "guarded_action",
        schema: "item",
        label: "Guarded",
        policy: { mode: "sync", transaction: false },
        exposure: "all",
        handler: async () => {
          actionExecuted = true;
          return { done: true };
        },
      });

      const guardedLayer = createCommandLayer({ executor: exec });

      guardedLayer.use({
        name: "strict-auth",
        slot: "auth",
        handler: async (ctx, _next) => {
          if (!ctx.actor || ctx.actor.id === "anonymous") {
            throw new PipelineError("Unauthenticated");
          }
        },
      });

      const result = await guardedLayer.execute({
        command: "guarded_action",
        input: {},
      });

      expect(result.success).toBe(false);
      expect(actionExecuted).toBe(false);
    });

    it("middleware NOT calling next() blocks action", async () => {
      let postActionRan = false;

      layer.use({
        name: "cache-bypass",
        slot: "pre-action",
        handler: async (_ctx, _next) => {
          // Intentionally does NOT call next()
        },
      });

      layer.use({
        name: "post-check",
        slot: "post-action",
        handler: async (_ctx, next) => {
          postActionRan = true;
          await next();
        },
      });

      const result = await layer.execute({ command: "echo", input: { message: "blocked" } });

      expect(result.success).toBe(false);
      expect(postActionRan).toBe(false);
    });

    it("permission slot can reject based on actor groups", async () => {
      layer.use({
        name: "require-admin",
        slot: "permission",
        handler: async (ctx, next) => {
          if (!ctx.actor.groups?.includes("admin")) {
            throw new PipelineError("Permission denied");
          }
          await next();
        },
      });

      const noAdmin = await layer.execute({
        command: "echo",
        input: { message: "hi" },
        actor: { type: "human", id: "user-1", groups: ["employee"] },
      });

      expect(noAdmin.success).toBe(false);

      const withAdmin = await layer.execute({
        command: "echo",
        input: { message: "hi" },
        actor: { type: "human", id: "admin-1", groups: ["admin"] },
      });

      expect(withAdmin.success).toBe(true);
    });
  });

  describe("Multiple middlewares in same slot", () => {
    it("multiple middlewares in pre slot run in registration order", async () => {
      const order: string[] = [];

      layer.use({
        name: "pre-1",
        slot: "pre",
        handler: async (_ctx, next) => {
          order.push("pre-1");
          await next();
        },
      });

      layer.use({
        name: "pre-2",
        slot: "pre",
        handler: async (_ctx, next) => {
          order.push("pre-2");
          await next();
        },
      });

      layer.use({
        name: "pre-3",
        slot: "pre",
        handler: async (_ctx, next) => {
          order.push("pre-3");
          await next();
        },
      });

      await layer.execute({ command: "echo", input: { message: "x" } });

      expect(order).toEqual(["pre-1", "pre-2", "pre-3"]);
    });

    it("early middleware in pre-action not calling next stops later pre-action middlewares", async () => {
      const ran: string[] = [];

      layer.use({
        name: "pre-action-blocker",
        slot: "pre-action",
        handler: async (_ctx, _next) => {
          ran.push("blocker");
          // Does NOT call next()
        },
      });

      layer.use({
        name: "pre-action-second",
        slot: "pre-action",
        handler: async (_ctx, next) => {
          ran.push("second");
          await next();
        },
      });

      const result = await layer.execute({ command: "echo", input: { message: "x" } });

      expect(result.success).toBe(false);
      expect(ran).toEqual(["blocker"]);
    });
  });

  describe("Integration: full pipeline with real action", () => {
    it("end-to-end create via CommandLayer creates and returns record", async () => {
      layer.use({
        name: "set-tenant",
        slot: "tenant",
        handler: async (ctx, next) => {
          ctx.tenantId = "tenant-abc";
          await next();
        },
      });

      layer.use({
        name: "set-actor",
        slot: "auth",
        handler: async (ctx, next) => {
          ctx.actor = { type: "human", id: "user-1", groups: ["staff"] };
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "Widget", category: "hardware" },
      });

      expect(result.success).toBe(true);
      const record = result.data as Record<string, unknown>;
      expect(record.id).toBeDefined();
      expect(record.name).toBe("Widget");
      expect(result.executionId).toBeDefined();
    });

    it("action not found returns error result", async () => {
      const result = await layer.execute({
        command: "nonexistent_action",
        input: {},
      });

      expect(result.success).toBe(false);
      expect((result.data as Record<string, unknown>).error).toContain("not found");
    });
  });

  describe("Tenant slot", () => {
    it("tenant slot can set tenantId, visible to subsequent slots", async () => {
      let capturedTenantId: string | undefined;

      layer.use({
        name: "resolve-tenant",
        slot: "tenant",
        handler: async (ctx, next) => {
          ctx.tenantId = "tenant-xyz";
          await next();
        },
      });

      layer.use({
        name: "read-tenant",
        slot: "pre-action",
        handler: async (ctx, next) => {
          capturedTenantId = ctx.tenantId;
          await next();
        },
      });

      await layer.execute({ command: "echo", input: { message: "x" } });

      expect(capturedTenantId).toBe("tenant-xyz");
    });
  });
});
