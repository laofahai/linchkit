import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config-loader";
import { resolve } from "node:path";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };
  const fixturesDir = resolve(import.meta.dir, "fixtures");

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when config file is missing", async () => {
    const config = await loadConfig({ root: "/tmp/nonexistent-dir-12345" });
    expect(config.server?.port).toBe(3001);
    expect(config.server?.host).toBe("0.0.0.0");
  });

  it("loads the project root config file", async () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const config = await loadConfig({ root: projectRoot });
    expect(config.server?.port).toBe(3001);
    expect(config.ai?.defaultProvider).toBe("anthropic");
  });

  it("resolves $env placeholders in the loaded config", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const projectRoot = resolve(import.meta.dir, "../../..");
    const config = await loadConfig({ root: projectRoot });
    expect(config.ai?.providers?.anthropic?.apiKey).toBe("sk-ant-test-key");
  });
});
