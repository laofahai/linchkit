import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolveEnvVars } from "../src/utils/env";

describe("resolveEnvVars", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_API_KEY = "sk-test-123";
    process.env.TEST_PORT = "8080";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("replaces $env.VAR_NAME with env var value", () => {
    const result = resolveEnvVars({ apiKey: "$env.TEST_API_KEY" });
    expect(result).toEqual({ apiKey: "sk-test-123" });
  });

  it("handles nested objects recursively", () => {
    const result = resolveEnvVars({
      ai: {
        providers: {
          anthropic: { apiKey: "$env.TEST_API_KEY" },
        },
      },
    });
    expect(result.ai.providers.anthropic.apiKey).toBe("sk-test-123");
  });

  it("handles arrays", () => {
    const result = resolveEnvVars(["$env.TEST_API_KEY", "plain"]);
    expect(result).toEqual(["sk-test-123", "plain"]);
  });

  it("passes through non-env strings unchanged", () => {
    const result = resolveEnvVars({ name: "hello", port: 3001, flag: true });
    expect(result).toEqual({ name: "hello", port: 3001, flag: true });
  });

  it("resolves missing env vars to undefined with a warning", () => {
    const warnSpy: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);

    const result = resolveEnvVars({ key: "$env.NONEXISTENT_VAR" });

    console.warn = origWarn;
    expect(result.key).toBeUndefined();
    expect(warnSpy.length).toBe(1);
    expect(warnSpy[0]).toContain("NONEXISTENT_VAR");
  });

  it("handles null and undefined gracefully", () => {
    expect(resolveEnvVars(null)).toBeNull();
    expect(resolveEnvVars(undefined)).toBeUndefined();
  });

  it("does not substitute partial matches", () => {
    const result = resolveEnvVars({ msg: "prefix $env.TEST_API_KEY suffix" });
    expect(result.msg).toBe("prefix $env.TEST_API_KEY suffix");
  });
});
