import { describe, expect, it } from "bun:test";
import { createBetterAuthProvider } from "../src/provider";

describe("BetterAuthProvider (skeleton)", () => {
  it("should create a provider instance", () => {
    const provider = createBetterAuthProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.login).toBe("function");
    expect(typeof provider.logout).toBe("function");
    expect(typeof provider.refreshToken).toBe("function");
    expect(typeof provider.createApiKey).toBe("function");
    expect(typeof provider.resetPassword).toBe("function");
    expect(typeof provider.resolveToken).toBe("function");
    expect(typeof provider.resolveApiKey).toBe("function");
    expect(typeof provider.resolveSession).toBe("function");
  });

  it("should return null from resolver stubs (no auth engine configured)", async () => {
    const provider = createBetterAuthProvider();
    expect(await provider.resolveToken("any_token")).toBeNull();
    expect(await provider.resolveApiKey("lk_any_key")).toBeNull();
    expect(await provider.resolveSession("any_session")).toBeNull();
  });

  it("should throw from action stubs (not yet implemented)", async () => {
    const provider = createBetterAuthProvider();
    const mockCtx = {
      input: {},
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
    };

    await expect(
      provider.login(mockCtx, { email: "test@test.com", password: "pass" }),
    ).rejects.toThrow("Not yet implemented");

    await expect(provider.logout(mockCtx, {})).rejects.toThrow("Not yet implemented");
  });
});
