/**
 * Command Layer — slot ordering, short-circuit, and individual slot behavior tests.
 */

import { describe, expect, test } from "bun:test";
import { PipelineError } from "../src/engine/command-layer";
import { createTestSetup } from "./command-layer-helpers";

describe("Command Layer: Slot Behavior", () => {
  describe("Slot ordering", () => {
    test("middlewares in the same slot execute by order (smaller first)", async () => {
      const { layer } = createTestSetup();
      const executionOrder: string[] = [];

      layer.use({
        name: "pre_c",
        slot: "pre",
        order: 300,
        handler: async (_ctx, next) => {
          executionOrder.push("pre_c");
          await next();
        },
      });
      layer.use({
        name: "pre_a",
        slot: "pre",
        order: 100,
        handler: async (_ctx, next) => {
          executionOrder.push("pre_a");
          await next();
        },
      });
      layer.use({
        name: "pre_b",
        slot: "pre",
        order: 200,
        handler: async (_ctx, next) => {
          executionOrder.push("pre_b");
          await next();
        },
      });

      await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(executionOrder).toEqual(["pre_a", "pre_b", "pre_c"]);
    });

    test("slots execute in correct pipeline order", async () => {
      const { layer } = createTestSetup();
      const executionOrder: string[] = [];

      layer.use({
        name: "pre_mw",
        slot: "pre",
        handler: async (_ctx, next) => {
          executionOrder.push("pre");
          await next();
        },
      });
      layer.use({
        name: "auth_mw",
        slot: "auth",
        handler: async (ctx, next) => {
          executionOrder.push("auth");
          ctx.actor = { type: "human", id: "user", groups: [] };
          await next();
        },
      });
      layer.use({
        name: "perm_mw",
        slot: "permission",
        handler: async (_ctx, next) => {
          executionOrder.push("permission");
          await next();
        },
      });
      layer.use({
        name: "tenant_mw",
        slot: "tenant",
        handler: async (ctx, next) => {
          executionOrder.push("tenant");
          ctx.tenantId = "t_001";
          await next();
        },
      });
      layer.use({
        name: "pre_action_mw",
        slot: "pre-action",
        handler: async (_ctx, next) => {
          executionOrder.push("pre-action");
          await next();
        },
      });
      layer.use({
        name: "post_action_mw",
        slot: "post-action",
        handler: async (_ctx, next) => {
          executionOrder.push("post-action");
          await next();
        },
      });

      await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(executionOrder).toEqual([
        "pre",
        "auth",
        // exposure runs here (built-in, no log)
        "permission",
        "tenant",
        "pre-action",
        // action runs here
        "post-action",
      ]);
    });
  });

  describe("Short-circuit on error", () => {
    test("error in auth prevents permission and action from running", async () => {
      const { layer } = createTestSetup();
      const executionOrder: string[] = [];

      layer.use({
        name: "failing_auth",
        slot: "auth",
        handler: async () => {
          executionOrder.push("auth");
          throw new PipelineError("Token expired", "AUTH.EXPIRED");
        },
      });
      layer.use({
        name: "perm",
        slot: "permission",
        handler: async (_ctx, next) => {
          executionOrder.push("permission");
          await next();
        },
      });

      const result = await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(result.success).toBe(false);
      expect((result.data as Record<string, unknown>).error).toBe("Token expired");
      expect(executionOrder).toEqual(["auth"]);
    });

    test("error in pre slot prevents subsequent slots", async () => {
      const { layer } = createTestSetup();
      let authRan = false;

      layer.use({
        name: "rate_limiter",
        slot: "pre",
        order: 10,
        handler: async () => {
          throw new PipelineError("Rate limit exceeded", "RATE_LIMIT.EXCEEDED");
        },
      });
      layer.use({
        name: "auth",
        slot: "auth",
        handler: async (_ctx, next) => {
          authRan = true;
          await next();
        },
      });

      const result = await layer.execute({ command: "create_item", input: {} });

      expect(result.success).toBe(false);
      expect(authRan).toBe(false);
    });
  });

  describe("Post-action slot", () => {
    test("post-action middleware receives execution result", async () => {
      const { layer } = createTestSetup();
      let capturedResult: unknown;

      layer.use({
        name: "result_logger",
        slot: "post-action",
        handler: async (ctx, next) => {
          capturedResult = ctx.result;
          await next();
        },
      });

      const result = await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(result.success).toBe(true);
      expect(capturedResult).toBeDefined();
      expect((capturedResult as Record<string, unknown>).success).toBe(true);
    });

    test("post-action error does not affect result", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "failing_post",
        slot: "post-action",
        handler: async () => {
          throw new Error("Post-action logging failed");
        },
      });

      const result = await layer.execute({ command: "create_item", input: { name: "test" } });
      expect(result.success).toBe(true);
    });
  });

  describe("Tenant slot", () => {
    test("tenant middleware sets tenantId on context", async () => {
      const { layer } = createTestSetup();
      let capturedTenantId: string | undefined;

      layer.use({
        name: "tenant_resolver",
        slot: "tenant",
        handler: async (ctx, next) => {
          ctx.tenantId = "tenant_abc";
          await next();
        },
      });
      layer.use({
        name: "capture",
        slot: "pre-action",
        handler: async (ctx, next) => {
          capturedTenantId = ctx.tenantId;
          await next();
        },
      });

      await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(capturedTenantId).toBe("tenant_abc");
    });
  });

  describe("Meta and headers", () => {
    test("headers are available in context", async () => {
      const { layer } = createTestSetup();
      let capturedHeaders: Record<string, string> | undefined;

      layer.use({
        name: "header_check",
        slot: "pre",
        handler: async (ctx, next) => {
          capturedHeaders = ctx.headers;
          await next();
        },
      });

      await layer.execute({
        command: "create_item",
        input: { name: "test" },
        headers: { authorization: "Bearer xyz", "x-request-id": "req_123" },
      });

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders?.authorization).toBe("Bearer xyz");
      expect(capturedHeaders?.["x-request-id"]).toBe("req_123");
    });

    test("meta allows middleware communication", async () => {
      const { layer } = createTestSetup();
      let readTimestamp: unknown;

      layer.use({
        name: "writer",
        slot: "pre",
        handler: async (ctx, next) => {
          ctx.meta.requestStart = Date.now();
          await next();
        },
      });
      layer.use({
        name: "reader",
        slot: "pre-action",
        handler: async (ctx, next) => {
          readTimestamp = ctx.meta.requestStart;
          await next();
        },
      });

      await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(readTimestamp).toBeDefined();
      expect(typeof readTimestamp).toBe("number");
    });
  });

  describe("Channel defaults", () => {
    test("defaults to 'internal' channel when not specified", async () => {
      const { layer } = createTestSetup();
      let capturedChannel: string | undefined;

      layer.use({
        name: "channel_check",
        slot: "pre",
        handler: async (ctx, next) => {
          capturedChannel = ctx.channel;
          await next();
        },
      });

      await layer.execute({ command: "create_item", input: { name: "test" } });

      expect(capturedChannel).toBe("internal");
    });
  });
});
