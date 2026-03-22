/**
 * Command Layer — auth/permission middleware integration tests.
 *
 * Verifies that LinchKitError (AuthenticationError, AuthorizationError)
 * thrown by middleware is properly propagated through the pipeline.
 */

import { describe, expect, test } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { AuthenticationError, AuthorizationError } from "../src/errors";
import type { ActionDefinition } from "../src/types/action";
import type { CommandContext } from "../src/types/capability";
import { createTestDataProvider } from "./command-layer-helpers";

function setup() {
  const dp = createTestDataProvider();
  const executor = createActionExecutor({ dataProvider: dp });

  const publicAction: ActionDefinition = {
    name: "health",
    schema: "system",
    label: "Health Check",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async () => ({ status: "ok" }),
  };

  const protectedAction: ActionDefinition = {
    name: "create_order",
    schema: "order",
    label: "Create Order",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => ctx.create("order", ctx.input),
  };

  executor.registry.register(publicAction);
  executor.registry.register(protectedAction);

  return { executor };
}

// Auth middleware that rejects anonymous requests
async function authMiddleware(
  ctx: CommandContext,
  next: () => Promise<void>,
): Promise<void> {
  const authHeader = ctx.meta?.authorization as string | undefined;
  if (!authHeader) {
    throw new AuthenticationError({
      code: "auth.credentials.required",
      message: "Authentication required",
    });
  }
  if (authHeader === "valid-token") {
    ctx.actor = { type: "human", id: "user1", groups: ["user"] };
  } else {
    throw new AuthenticationError({
      code: "auth.token.invalid",
      message: "Invalid token",
    });
  }
  return next();
}

// Permission middleware that checks groups
async function permissionMiddleware(
  ctx: CommandContext,
  next: () => Promise<void>,
): Promise<void> {
  if (ctx.command === "health") return next();

  if (ctx.actor.groups.length === 0) {
    throw new AuthorizationError({
      code: "authz.action.denied",
      message: `Permission denied for action "${ctx.command}"`,
    });
  }
  return next();
}

describe("CommandLayer auth/permission error propagation", () => {
  test("returns auth error code when no credentials provided", async () => {
    const { executor } = setup();
    const layer = createCommandLayer({ executor });
    layer.use({ name: "test-auth", slot: "auth", handler: authMiddleware });

    const result = await layer.execute({
      command: "create_order",
      input: { item: "test" },
      actor: { type: "human", id: "anonymous", groups: [] },
      channel: "http",
    });

    expect(result.success).toBe(false);
    expect(result.data).toHaveProperty("code", "auth.credentials.required");
    expect(result.data).toHaveProperty("error", "Authentication required");
  });

  test("returns auth error for invalid token", async () => {
    const { executor } = setup();
    const layer = createCommandLayer({ executor });
    layer.use({ name: "test-auth", slot: "auth", handler: authMiddleware });

    const result = await layer.execute({
      command: "create_order",
      input: { item: "test" },
      actor: { type: "human", id: "anonymous", groups: [] },
      channel: "http",
      meta: { authorization: "bad-token" },
    });

    expect(result.success).toBe(false);
    expect(result.data).toHaveProperty("code", "auth.token.invalid");
  });

  test("authenticated + authorized request succeeds", async () => {
    const { executor } = setup();
    const layer = createCommandLayer({ executor });
    layer.use({ name: "test-auth", slot: "auth", handler: authMiddleware });
    layer.use({ name: "test-perm", slot: "permission", handler: permissionMiddleware });

    const result = await layer.execute({
      command: "create_order",
      input: { item: "test" },
      actor: { type: "human", id: "anonymous", groups: [] },
      channel: "http",
      meta: { authorization: "valid-token" },
    });

    expect(result.success).toBe(true);
  });

  test("permission middleware blocks ungrouped actor", async () => {
    const { executor } = setup();
    const layer = createCommandLayer({ executor });
    layer.use({ name: "test-perm", slot: "permission", handler: permissionMiddleware });

    const result = await layer.execute({
      command: "create_order",
      input: { item: "test" },
      actor: { type: "human", id: "anonymous", groups: [] },
      channel: "http",
    });

    expect(result.success).toBe(false);
    expect(result.data).toHaveProperty("code", "authz.action.denied");
  });

  test("public action bypasses permission check", async () => {
    const { executor } = setup();
    const layer = createCommandLayer({ executor });
    layer.use({ name: "test-perm", slot: "permission", handler: permissionMiddleware });

    const result = await layer.execute({
      command: "health",
      input: {},
      actor: { type: "human", id: "anonymous", groups: [] },
      channel: "http",
    });

    expect(result.success).toBe(true);
  });
});
