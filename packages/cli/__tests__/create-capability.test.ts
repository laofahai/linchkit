import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-create");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

async function runCreate(...extraArgs: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "create", "capability", ...extraArgs], {
    cwd: TEST_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode, stdout, stderr };
}

describe("linch create capability", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("creates expected directory structure with defaults", async () => {
    const { stdout } = await runCreate("cap-inventory", "--dir", "cap-inventory");

    expect(stdout).toContain("Capability created successfully!");

    const capDir = resolve(TEST_DIR, "cap-inventory");

    // Verify files exist
    expect(existsSync(resolve(capDir, "capability.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "package.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/index.ts"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/schemas/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/actions/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/rules/.gitkeep"))).toBe(true);
  });

  test("capability.json passes validateCapabilityMetadata", async () => {
    await runCreate("cap-test-valid", "--dir", "cap-test-valid");

    const capDir = resolve(TEST_DIR, "cap-test-valid");
    const raw = readFileSync(resolve(capDir, "capability.json"), "utf-8");
    const parsed = JSON.parse(raw);

    const result = validateCapabilityMetadata(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("cap-test-valid");
      expect(result.data.type).toBe("standard");
      expect(result.data.category).toBe("business");
      expect(result.data.version).toBe("0.1.0");
    }
  });

  test("respects custom --type and --category", async () => {
    await runCreate(
      "cap-mcp-adapter",
      "--type",
      "adapter",
      "--category",
      "integration",
      "--dir",
      "cap-mcp-adapter",
    );

    const capDir = resolve(TEST_DIR, "cap-mcp-adapter");
    const raw = readFileSync(resolve(capDir, "capability.json"), "utf-8");
    const parsed = JSON.parse(raw);

    const result = validateCapabilityMetadata(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("adapter");
      expect(result.data.category).toBe("integration");
    }
  });

  test("package.json has correct name and peer dependency", async () => {
    await runCreate("cap-billing", "--dir", "cap-billing");

    const capDir = resolve(TEST_DIR, "cap-billing");
    const raw = readFileSync(resolve(capDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.name).toBe("@linchkit/cap-billing");
    expect(parsed.peerDependencies["@linchkit/core"]).toBe("workspace:*");
    expect(parsed.type).toBe("module");
  });

  test("src/index.ts exports capability definition", async () => {
    await runCreate("cap-check", "--dir", "cap-check");

    const capDir = resolve(TEST_DIR, "cap-check");
    const content = readFileSync(resolve(capDir, "src/index.ts"), "utf-8");

    expect(content).toContain('import type { CapabilityDefinition } from "@linchkit/core"');
    // Variable name is derived from sanitized capability name (hyphens → underscores)
    expect(content).toContain("cap_check: CapabilityDefinition");
    expect(content).toContain('"cap-check"');
  });

  test("fails if directory already exists", async () => {
    mkdirSync(resolve(TEST_DIR, "cap-exists"), { recursive: true });

    const { stderr } = await runCreate("cap-exists", "--dir", "cap-exists");

    expect(stderr).toContain("already exists");
  });

  test("rejects invalid type", async () => {
    const { stderr } = await runCreate("cap-bad", "--type", "invalid", "--dir", "cap-bad");

    expect(stderr).toContain("Invalid type");
  });

  test("rejects invalid category", async () => {
    const { stderr } = await runCreate("cap-bad", "--category", "invalid", "--dir", "cap-bad");

    expect(stderr).toContain("Invalid category");
  });
});
