import { describe, expect, it } from "bun:test";
import type { Actor, CommandContext } from "@linchkit/core";
import { AuthenticationError } from "@linchkit/core";
import { createAuthMiddleware } from "../src/middleware/auth-middleware";

/** Helper to create a minimal CommandContext for testing */
function createTestContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    command: "test_action",
    input: {},
    channel: "http",
    actor: { type: "system", id: "anonymous", groups: [] },
    meta: {},
    ...overrides,
  };
}

const testUser: Actor = {
  type: "human",
  id: "user_001",
  name: "Test User",
  groups: ["editors"],
};

describe("auth middleware", () => {
  const resolveToken = async (token: string): Promise<Actor | null> => {
    if (token === "eyJvalid_jwt_token") return testUser;
    return null;
  };

  const resolveApiKey = async (key: string): Promise<Actor | null> => {
    if (key === "lk_valid_key") return { ...testUser, type: "external", id: "api_user_001" };
    return null;
  };

  const resolveSession = async (sid: string): Promise<Actor | null> => {
    if (sid === "valid_session") return testUser;
    return null;
  };

  const middleware = createAuthMiddleware({
    resolveToken,
    resolveApiKey,
    resolveSession,
  });

  it("should resolve JWT Bearer token to actor", async () => {
    const ctx = createTestContext({
      headers: { authorization: "Bearer eyJvalid_jwt_token" },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(ctx.actor.id).toBe("user_001");
    expect(ctx.meta.authMethod).toBe("bearer");
  });

  it("should reject invalid JWT Bearer token", async () => {
    const ctx = createTestContext({
      headers: { authorization: "Bearer eyJinvalid_token" },
    });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthenticationError);
  });

  it("should resolve API key via Bearer lk_ prefix", async () => {
    const ctx = createTestContext({
      headers: { authorization: "Bearer lk_valid_key" },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(ctx.actor.id).toBe("api_user_001");
    expect(ctx.meta.authMethod).toBe("api_key");
  });

  it("should reject invalid API key via Bearer lk_ prefix", async () => {
    const ctx = createTestContext({
      headers: { authorization: "Bearer lk_bad_key" },
    });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthenticationError);
  });

  it("should resolve session cookie", async () => {
    const ctx = createTestContext({
      headers: { cookie: "lk_session=valid_session; other=value" },
    });

    await middleware(ctx, async () => {});

    expect(ctx.actor.id).toBe("user_001");
    expect(ctx.meta.authMethod).toBe("session");
  });

  it("should reject invalid session", async () => {
    const ctx = createTestContext({
      headers: { cookie: "lk_session=invalid_session" },
    });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthenticationError);
  });

  it("should allow anonymous when allowAnonymous is true (default)", async () => {
    const ctx = createTestContext({ headers: {} });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(ctx.actor.id).toBe("anonymous");
    expect(ctx.meta.authMethod).toBe("anonymous");
  });

  it("should reject anonymous when allowAnonymous is false", async () => {
    const strictMiddleware = createAuthMiddleware({
      resolveToken,
      resolveApiKey,
      resolveSession,
      allowAnonymous: false,
    });

    const ctx = createTestContext({ headers: {} });

    await expect(strictMiddleware(ctx, async () => {})).rejects.toThrow(AuthenticationError);
  });

  it("should route lk_ prefixed Bearer token to API key resolver, not JWT", async () => {
    const ctx = createTestContext({
      headers: { authorization: "Bearer lk_valid_key" },
    });

    await middleware(ctx, async () => {});

    // Must use API key channel, not JWT
    expect(ctx.meta.authMethod).toBe("api_key");
    expect(ctx.actor.id).toBe("api_user_001");
  });

  it("should prefer Bearer token over session cookie", async () => {
    const ctx = createTestContext({
      headers: {
        authorization: "Bearer eyJvalid_jwt_token",
        cookie: "lk_session=valid_session",
      },
    });

    await middleware(ctx, async () => {});

    expect(ctx.meta.authMethod).toBe("bearer");
    expect(ctx.actor.id).toBe("user_001");
  });
});
