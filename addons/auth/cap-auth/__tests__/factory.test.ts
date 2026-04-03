import { describe, expect, it } from "bun:test";
import type { ActionContext, Actor } from "@linchkit/core";
import { createCapAuth } from "../src/factory";
import type { AuthProvider } from "../src/types";

/** Minimal mock AuthProvider for testing the factory wiring */
function createMockProvider(): AuthProvider {
  const testUser: Actor = {
    type: "human",
    id: "user_001",
    name: "Test User",
    groups: ["staff"],
  };

  return {
    login: async (_ctx, _input) => ({
      access_token: "jwt_token",
      refresh_token: "refresh_token",
      expires_in: 900,
    }),
    logout: async (_ctx, _input) => {},
    refreshToken: async (_ctx, _input) => ({
      access_token: "new_jwt_token",
      expires_at: "2026-04-01T00:00:00Z",
    }),
    createApiKey: async (_ctx, _input) => ({
      key: "lk_test_key_abc123",
      key_prefix: "lk_test",
    }),
    register: async (_ctx, _input) => ({
      access_token: "jwt_token",
      refresh_token: "refresh_token",
      expires_in: 900,
    }),
    resetPassword: async (_ctx, _input) => ({
      success: true,
    }),
    resolveToken: async (token) => (token === "valid" ? testUser : null),
    resolveApiKey: async (key) => (key === "lk_valid" ? testUser : null),
    resolveSession: async (sid) => (sid === "valid_session" ? testUser : null),
  };
}

describe("createCapAuth factory", () => {
  it("should produce a capability with same metadata as static contract", () => {
    const cap = createCapAuth({ provider: createMockProvider() });
    expect(cap.name).toBe("cap-auth");
    expect(cap.type).toBe("standard");
    expect(cap.category).toBe("system");
    expect(cap.version).toBe("0.0.1");
  });

  it("should produce 4 schemas", () => {
    const cap = createCapAuth({ provider: createMockProvider() });
    expect(cap.entities).toHaveLength(4);
  });

  it("should produce 6 actions WITH handlers when provider is supplied", () => {
    const cap = createCapAuth({ provider: createMockProvider() });
    expect(cap.actions).toHaveLength(6);

    for (const action of cap.actions ?? []) {
      expect(action.handler).toBeDefined();
      expect(typeof action.handler).toBe("function");
    }
  });

  it("should produce 6 actions WITHOUT handlers when no provider is supplied", () => {
    const cap = createCapAuth();
    expect(cap.actions).toHaveLength(6);

    for (const action of cap.actions ?? []) {
      expect(action.handler).toBeUndefined();
    }
  });

  it("should include middleware registration when provider is supplied", () => {
    const cap = createCapAuth({ provider: createMockProvider() });
    expect(cap.extensions?.middlewares).toBeDefined();
    expect(cap.extensions?.middlewares).toHaveLength(1);
    const mw = cap.extensions?.middlewares?.[0];
    expect(mw?.slot).toBe("auth");
    expect(typeof mw?.handler).toBe("function");
  });

  it("should NOT include middleware when no provider is supplied", () => {
    const cap = createCapAuth();
    // extensions may have permissionGroups but should NOT have middlewares
    expect(cap.extensions?.middlewares).toBeUndefined();
  });

  it("should wire login action handler to provider.login", async () => {
    const provider = createMockProvider();
    const cap = createCapAuth({ provider });
    const loginAction = cap.actions?.find((a) => a.name === "login");

    expect(loginAction?.handler).toBeDefined();

    const mockCtx = {
      input: { email: "test@example.com", password: "secret" },
      actor: { type: "system" as const, id: "anonymous", groups: [] },
      executionId: "exec_001",
      timestamp: new Date(),
      get: async () => ({}),
      query: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => {},
      execute: async () => {},
      emit: () => {},
    } satisfies ActionContext;

    const handler = loginAction?.handler;
    expect(handler).toBeDefined();
    const result = await handler?.(mockCtx);
    expect(result).toEqual({
      access_token: "jwt_token",
      refresh_token: "refresh_token",
      expires_in: 900,
    });
  });
});
