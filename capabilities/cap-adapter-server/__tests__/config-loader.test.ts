import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../src/config-loader";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };
  const _fixturesDir = resolve(import.meta.dir, "fixtures");

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
    expect(config.ai?.defaultProvider).toBe("volcengine");
  });

  it("resolves $env placeholders in the loaded config", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const projectRoot = resolve(import.meta.dir, "../../..");
    const config = await loadConfig({ root: projectRoot });
    expect(config.ai?.providers?.anthropic?.apiKey).toBe("sk-ant-test-key");
  });
});
