/**
 * Command Layer — integration tests.
 *
 * Covers: middleware not calling next() blocks action, input mutation,
 * granular skip flags, executionId format, fail-closed permission.
 */

import { describe, expect, test } from "bun:test";
import { createTestSetup } from "./command-layer-helpers";

describe("Command Layer: Integration", () => {
  describe("Middleware not calling next() blocks action", () => {
    test("pre-action middleware not calling next() blocks action execution", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "cache_hit",
        slot: "pre-action",
        handler: async (_ctx, _next) => {
          // Intentionally do NOT call next()
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      // Action is blocked — not calling next() prevents action from running
      expect(result.success).toBe(false);
      expect((result.data as Record<string, unknown>).error).toBe("Request blocked by pipeline");
    });

    test("auth middleware not calling next() blocks subsequent slots and action", async () => {
      const { layer } = createTestSetup();
      let permissionRan = false;

      layer.use({
        name: "blocking_auth",
        slot: "auth",
        handler: async (_ctx, _next) => {
          // Returns without calling next
        },
      });

      layer.use({
        name: "perm",
        slot: "permission",
        handler: async (_ctx, next) => {
          permissionRan = true;
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      // Action is blocked — auth didn't call next()
      expect(result.success).toBe(false);
      expect((result.data as Record<string, unknown>).error).toBe("Request blocked by pipeline");
      // Downstream middleware in the composed chain was skipped
      expect(permissionRan).toBe(false);
    });
  });

  describe("Input mutation by middleware", () => {
    test("pre-action middleware can enrich input and changes are seen by action", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "input_enricher",
        slot: "pre-action",
        handler: async (ctx, next) => {
          ctx.input.enriched = true;
          ctx.input.source = "middleware";
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "enriched_item" },
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data).toBeDefined();
      expect(data.enriched).toBe(true);
      expect(data.source).toBe("middleware");
    });

    test("input shallow copy isolates caller object from middleware mutations", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "mutator",
        slot: "pre-action",
        handler: async (ctx, next) => {
          ctx.input.injected = true;
          await next();
        },
      });

      const originalInput = { name: "test" };
      await layer.execute({ command: "create_item", input: originalInput });

      // Caller's original object should NOT be mutated
      expect(originalInput).toEqual({ name: "test" });
    });
  });

  describe("Permission is pipeline-owned", () => {
    // Unified permission model (#125): the Action Engine no longer performs
    // any permission check. Permission enforcement is owned by the pipeline
    // (permission-slot middleware, typically provided by a permission
    // capability such as cap-permission). Without a permission middleware,
    // all actions pass the permission stage.

    test("action executes when no permission middleware is registered", async () => {
      const { layer } = createTestSetup();

      // admin_action used to be rejected by the executor's built-in check.
      // Under the new model, the pipeline is the sole authority, so the
      // action proceeds when no permission middleware is wired.
      const result = await layer.execute({
        command: "admin_action",
        input: {},
      });

      expect(result.success).toBe(true);
    });

    test("permission middleware can allow requests", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "lenient_perm",
        slot: "permission",
        handler: async (_ctx, next) => {
          await next();
        },
      });

      const result = await layer.execute({
        command: "admin_action",
        input: {},
      });

      expect(result.success).toBe(true);
    });

    test("action without permission restrictions works without permission middleware", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("executionId for pipeline errors", () => {
    test("pipeline error returns a non-empty executionId with pipeline_ prefix", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "nonexistent_action",
        input: {},
      });

      expect(result.success).toBe(false);
      expect(result.executionId).toBeTruthy();
      expect(result.executionId.startsWith("pipeline_")).toBe(true);
    });

    test("pipeline executionId includes counter for uniqueness", async () => {
      const { layer } = createTestSetup();

      const result1 = await layer.execute({ command: "nonexistent_action", input: {} });
      const result2 = await layer.execute({ command: "nonexistent_action", input: {} });

      // IDs should be different even if called in rapid succession
      expect(result1.executionId).not.toBe(result2.executionId);
    });
  });

  describe("Unknown error sanitization", () => {
    test("unknown errors are sanitized to prevent information leakage", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "leaky_middleware",
        slot: "pre",
        handler: async () => {
          // Simulate an internal error with sensitive details
          throw new TypeError("Cannot read property 'x' of undefined at /internal/path/secret.ts");
        },
      });

      const result = await layer.execute({ command: "create_item", input: {} });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      // Should NOT contain the original error message
      expect(data.error).toBe("Internal pipeline error");
    });
  });
});
