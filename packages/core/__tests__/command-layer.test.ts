/**
 * Command Layer — core pipeline tests.
 *
 * Covers: empty pipeline, auth slot, permission slot, exposure check (built-in).
 */

import { describe, expect, test } from "bun:test";
import { PipelineError, type SlotName } from "../src/engine/command-layer";
import type { Actor } from "../src/types/action";
import { createTestSetup } from "./command-layer-helpers";

describe("Command Layer: Core Pipeline", () => {
  describe("Empty pipeline (no middleware)", () => {
    test("executes action directly when no middlewares registered", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      expect(result.success).toBe(true);
    });

    test("anonymous actor is used by default", async () => {
      const { layer } = createTestSetup();
      let capturedActor: Actor | undefined;

      layer.use({
        name: "capture_actor",
        slot: "pre",
        handler: async (ctx, next) => {
          capturedActor = ctx.actor;
          await next();
        },
      });

      await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      expect(capturedActor).toBeDefined();
      expect(capturedActor?.type).toBe("system");
      expect(capturedActor?.id).toBe("anonymous");
      expect(capturedActor?.groups).toEqual([]);
    });

    test("returns error for non-existent action", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "nonexistent_action",
        input: {},
      });

      expect(result.success).toBe(false);
      expect((result.data as Record<string, unknown>).error).toContain("not found");
    });
  });

  describe("Auth slot", () => {
    test("auth middleware sets actor on context", async () => {
      const { layer } = createTestSetup();
      let actorAfterAuth: Actor | undefined;

      layer.use({
        name: "test_auth",
        slot: "auth",
        handler: async (ctx, next) => {
          ctx.actor = { type: "human", id: "user_123", groups: ["admin"] };
          await next();
        },
      });

      layer.use({
        name: "capture",
        slot: "pre-action",
        handler: async (ctx, next) => {
          actorAfterAuth = ctx.actor;
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
      });

      expect(result.success).toBe(true);
      expect(actorAfterAuth).toBeDefined();
      expect(actorAfterAuth?.id).toBe("user_123");
      expect(actorAfterAuth?.groups).toEqual(["admin"]);
    });

    test("auth middleware can reject unauthenticated requests", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "strict_auth",
        slot: "auth",
        handler: async (ctx, _next) => {
          if (!ctx.headers?.authorization) {
            throw new PipelineError("Authentication required", "AUTH.REQUIRED");
          }
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
        channel: "http",
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error).toBe("Authentication required");
      expect(data.code).toBe("AUTH.REQUIRED");
    });

    test("auth middleware passes when token is present", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "token_auth",
        slot: "auth",
        handler: async (ctx, next) => {
          if (ctx.headers?.authorization) {
            ctx.actor = { type: "human", id: "authenticated_user", groups: ["user"] };
          }
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "test" },
        channel: "http",
        headers: { authorization: "Bearer test-token" },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Permission slot", () => {
    test("permission middleware blocks unauthorized requests", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "perm_check",
        slot: "permission",
        handler: async (ctx, next) => {
          const action = ctx.action;
          if (action?.permissions?.groups) {
            const hasGroup = ctx.actor.groups.some((g) => action.permissions?.groups?.includes(g));
            if (!hasGroup) {
              throw new PipelineError("Insufficient permissions", "PERMISSION.DENIED");
            }
          }
          await next();
        },
      });

      const result = await layer.execute({
        command: "admin_action",
        input: {},
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error).toBe("Insufficient permissions");
    });

    test("permission middleware allows authorized requests", async () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "auth",
        slot: "auth",
        handler: async (ctx, next) => {
          ctx.actor = { type: "human", id: "admin_user", groups: ["admin"] };
          await next();
        },
      });

      layer.use({
        name: "perm_check",
        slot: "permission",
        handler: async (ctx, next) => {
          const action = ctx.action;
          if (action?.permissions?.groups) {
            const hasGroup = ctx.actor.groups.some((g) => action.permissions?.groups?.includes(g));
            if (!hasGroup) {
              throw new PipelineError("Insufficient permissions", "PERMISSION.DENIED");
            }
          }
          await next();
        },
      });

      const result = await layer.execute({
        command: "admin_action",
        input: {},
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Exposure check (built-in)", () => {
    test("blocks action not exposed for the channel", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "internal_only",
        input: {},
        channel: "http",
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error as string).toContain("not exposed");
      expect(data.error as string).toContain("http");
    });

    test("allows action exposed for the channel", async () => {
      const { layer } = createTestSetup();

      const result = await layer.execute({
        command: "internal_only",
        input: {},
        channel: "internal",
      });

      expect(result.success).toBe(true);
    });

    test("allows action with exposure 'all' on any channel", async () => {
      const { layer } = createTestSetup();

      for (const ch of ["http", "mcp", "cli", "ui", "internal"] as const) {
        const result = await layer.execute({
          command: "create_item",
          input: { name: `test_${ch}` },
          channel: ch,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("Registration validation", () => {
    test("rejects duplicate middleware name", () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "my_mw",
        slot: "pre",
        handler: async (_ctx, next) => next(),
      });

      expect(() => {
        layer.use({
          name: "my_mw",
          slot: "auth",
          handler: async (_ctx, next) => next(),
        });
      }).toThrow("already registered");
    });

    test("rejects registration into exposure slot", () => {
      const { layer } = createTestSetup();

      expect(() => {
        layer.use({
          name: "bad_mw",
          slot: "exposure",
          handler: async (_ctx, next) => next(),
        });
      }).toThrow("exposure");
    });

    test("rejects invalid slot name", () => {
      const { layer } = createTestSetup();

      expect(() => {
        layer.use({
          name: "bad_slot",
          slot: "invalid" as SlotName,
          handler: async (_ctx, next) => next(),
        });
      }).toThrow("Invalid slot");
    });

    test("getMiddlewares returns registered middlewares", () => {
      const { layer } = createTestSetup();

      layer.use({
        name: "mw_a",
        slot: "pre",
        order: 10,
        handler: async (_ctx, next) => next(),
      });
      layer.use({
        name: "mw_b",
        slot: "auth",
        handler: async (_ctx, next) => next(),
      });

      const mws = layer.getMiddlewares();
      expect(mws).toHaveLength(2);
      expect(mws[0].name).toBe("mw_a");
      expect(mws[1].name).toBe("mw_b");
    });
  });

  describe("Approval re-execution (approvalId)", () => {
    test("execute with valid approvalId and verifyApproval skips auth/exposure/permission but runs other slots", async () => {
      const { layer } = createTestSetup({
        verifyApproval: async () => true,
      });
      const slotsExecuted: string[] = [];

      layer.use({
        name: "track_pre",
        slot: "pre",
        handler: async (_ctx, next) => {
          slotsExecuted.push("pre");
          await next();
        },
      });
      layer.use({
        name: "track_auth",
        slot: "auth",
        handler: async (_ctx, next) => {
          slotsExecuted.push("auth");
          await next();
        },
      });
      layer.use({
        name: "track_permission",
        slot: "permission",
        handler: async (_ctx, next) => {
          slotsExecuted.push("permission");
          await next();
        },
      });
      layer.use({
        name: "track_tenant",
        slot: "tenant",
        handler: async (_ctx, next) => {
          slotsExecuted.push("tenant");
          await next();
        },
      });
      layer.use({
        name: "track_pre_action",
        slot: "pre-action",
        handler: async (_ctx, next) => {
          slotsExecuted.push("pre-action");
          await next();
        },
      });
      layer.use({
        name: "track_post_action",
        slot: "post-action",
        handler: async (_ctx, next) => {
          slotsExecuted.push("post-action");
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "approved-item" },
        approvalId: "approval_123",
        actor: { type: "human", id: "user_1", groups: [] },
      });

      expect(result.success).toBe(true);

      // Skipped slots
      expect(slotsExecuted).not.toContain("auth");
      expect(slotsExecuted).not.toContain("permission");
      // Exposure is built-in, not tracked by middleware, but should be skipped internally

      // Executed slots
      expect(slotsExecuted).toContain("pre");
      expect(slotsExecuted).toContain("tenant");
      expect(slotsExecuted).toContain("pre-action");
      expect(slotsExecuted).toContain("post-action");
    });

    test("execute without approvalId runs all slots normally", async () => {
      const { layer } = createTestSetup();
      const slotsExecuted: string[] = [];

      layer.use({
        name: "track_auth",
        slot: "auth",
        handler: async (_ctx, next) => {
          slotsExecuted.push("auth");
          await next();
        },
      });
      layer.use({
        name: "track_permission",
        slot: "permission",
        handler: async (_ctx, next) => {
          slotsExecuted.push("permission");
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "normal-item" },
      });

      expect(result.success).toBe(true);
      expect(slotsExecuted).toContain("auth");
      expect(slotsExecuted).toContain("permission");
    });

    test("approval re-execution with valid verifyApproval skips exposure check for non-exposed channel", async () => {
      const { layer } = createTestSetup({
        verifyApproval: async () => true,
      });

      // internal_only is not exposed for http, but with valid approvalId it should pass
      const result = await layer.execute({
        command: "internal_only",
        input: {},
        channel: "http",
        approvalId: "approval_456",
        actor: { type: "human", id: "user_1", groups: [] },
      });

      expect(result.success).toBe(true);
    });

    test("fake approvalId without verifyApproval configured — slots NOT skipped (fail-closed)", async () => {
      const { layer } = createTestSetup(); // No verifyApproval
      const slotsExecuted: string[] = [];

      layer.use({
        name: "track_auth",
        slot: "auth",
        handler: async (_ctx, next) => {
          slotsExecuted.push("auth");
          await next();
        },
      });
      layer.use({
        name: "track_permission",
        slot: "permission",
        handler: async (_ctx, next) => {
          slotsExecuted.push("permission");
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "fake-approval" },
        approvalId: "fake_approval_id",
        actor: { type: "human", id: "attacker", groups: [] },
      });

      // Action still succeeds (no middleware blocks it), but security slots ran
      expect(result.success).toBe(true);
      expect(slotsExecuted).toContain("auth");
      expect(slotsExecuted).toContain("permission");
    });

    test("fake approvalId with verifyApproval returning false — error returned", async () => {
      const { layer } = createTestSetup({
        verifyApproval: async () => false,
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "fake-approval" },
        approvalId: "fake_approval_id",
        actor: { type: "human", id: "attacker", groups: [] },
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error).toContain("Invalid or unapproved approvalId");
      expect(data.code).toBe("APPROVAL.INVALID");
    });

    test("valid approvalId with verifyApproval returning true — slots skipped correctly", async () => {
      const verifiedIds = new Set(["real_approval_001"]);
      const { layer } = createTestSetup({
        verifyApproval: async (id) => verifiedIds.has(id),
      });
      const slotsExecuted: string[] = [];

      layer.use({
        name: "track_auth",
        slot: "auth",
        handler: async (_ctx, next) => {
          slotsExecuted.push("auth");
          await next();
        },
      });
      layer.use({
        name: "track_permission",
        slot: "permission",
        handler: async (_ctx, next) => {
          slotsExecuted.push("permission");
          await next();
        },
      });
      layer.use({
        name: "track_tenant",
        slot: "tenant",
        handler: async (_ctx, next) => {
          slotsExecuted.push("tenant");
          await next();
        },
      });

      const result = await layer.execute({
        command: "create_item",
        input: { name: "approved-item" },
        approvalId: "real_approval_001",
        actor: { type: "human", id: "user_1", groups: [] },
      });

      expect(result.success).toBe(true);
      expect(slotsExecuted).not.toContain("auth");
      expect(slotsExecuted).not.toContain("permission");
      expect(slotsExecuted).toContain("tenant");
    });

    test("without verifyApproval, exposure check still applies to non-exposed channels", async () => {
      const { layer } = createTestSetup(); // No verifyApproval

      // internal_only is not exposed for http; without verifyApproval, exposure check runs
      const result = await layer.execute({
        command: "internal_only",
        input: {},
        channel: "http",
        approvalId: "fake_approval_id",
        actor: { type: "human", id: "user_1", groups: [] },
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error as string).toContain("not exposed");
    });
  });
});
