import { describe, expect, it } from "bun:test";
import type { BetterAuthProviderOptions } from "../src/provider";
import { createBetterAuthProvider } from "../src/provider";

/**
 * Unit tests for BetterAuthProvider.
 *
 * These tests verify the provider can be instantiated and exports
 * the correct interface. Full integration tests require a running
 * PostgreSQL database and are out of scope for unit tests.
 */

// Mock Drizzle DB instance — just enough structure for betterAuth() initialization
const mockDb = {
  _: { fullSchema: {} },
  query: {},
  select: () => mockDb,
  from: () => mockDb,
  where: () => mockDb,
  insert: () => mockDb,
  values: () => mockDb,
  update: () => mockDb,
  set: () => mockDb,
  delete: () => mockDb,
  execute: () => Promise.resolve([]),
};

const testOptions: BetterAuthProviderOptions = {
  database: mockDb,
  secret: "test-secret-key-for-unit-tests",
  baseURL: "http://localhost:3001",
};

describe("BetterAuthProvider", () => {
  it("should create a provider instance with required options", () => {
    const provider = createBetterAuthProvider(testOptions);
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

  it("resolveApiKey should return null (API keys not managed by better-auth)", async () => {
    const provider = createBetterAuthProvider(testOptions);
    const result = await provider.resolveApiKey("lk_some_test_key");
    expect(result).toBeNull();
  });

  it("resolveToken should return null for invalid token", async () => {
    const provider = createBetterAuthProvider(testOptions);
    const result = await provider.resolveToken("invalid-token");
    expect(result).toBeNull();
  });

  it("resolveSession should return null for invalid session", async () => {
    const provider = createBetterAuthProvider(testOptions);
    const result = await provider.resolveSession("invalid-session-id");
    expect(result).toBeNull();
  });
});
