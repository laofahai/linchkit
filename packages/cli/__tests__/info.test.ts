import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-info");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

/** Write a minimal linchkit.config.ts file */
function writeConfig(dir: string, content: string) {
  writeFileSync(resolve(dir, "linchkit.config.ts"), content);
}

describe("linch info", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows error when no config file exists", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "info"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const output = stdout + stderr;

    expect(output).toContain("No linchkit.config.ts found");
  });

  test("shows project info with empty config", async () => {
    writeConfig(TEST_DIR, `export default { capabilities: [] };`);

    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "info"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(stdout).toContain("LinchKit Project Info");
    expect(stdout).toContain("Capabilities: 0");
    expect(stdout).toContain("Schemas:");
    expect(stdout).toContain("Actions:");
    expect(stdout).toContain("Database:");
  });

  test("--json outputs valid JSON", async () => {
    writeConfig(TEST_DIR, `export default { capabilities: [] };`);

    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "info", "--json"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.counts.capabilities).toBe(0);
    expect(parsed.counts.schemas).toBe(0);
    expect(parsed.counts.actions).toBe(0);
    expect(parsed.database.configured).toBe(false);
  });

  test("shows capability details when capabilities are configured", async () => {
    writeConfig(
      TEST_DIR,
      `
export default {
  capabilities: [
    {
      name: "cap-test",
      label: "Test Cap",
      type: "standard",
      category: "business",
      version: "0.1.0",
      entities: [{ name: "test_schema", label: "Test", fields: {} }],
      actions: [
        { name: "create_test", label: "Create Test", entity: "test_schema", type: "create", handler: async () => ({}) },
      ],
    },
  ],
};
`,
    );

    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "info"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(stdout).toContain("Capabilities: 1");
    expect(stdout).toContain("cap-test");
    expect(stdout).toContain("standard");
    expect(stdout).toContain("Schemas:");
  });

  test("--json includes capability list with type and version", async () => {
    writeConfig(
      TEST_DIR,
      `
export default {
  capabilities: [
    {
      name: "cap-demo",
      label: "Demo",
      type: "adapter",
      category: "integration",
      version: "2.0.0",
      entities: [
        { name: "s1", label: "S1", fields: {} },
        { name: "s2", label: "S2", fields: {} },
      ],
    },
  ],
};
`,
    );

    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "info", "--json"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.capabilities).toHaveLength(1);
    expect(parsed.capabilities[0].name).toBe("cap-demo");
    expect(parsed.capabilities[0].type).toBe("adapter");
    expect(parsed.capabilities[0].version).toBe("2.0.0");
    expect(parsed.counts.schemas).toBe(2);
    expect(parsed.counts.capabilities).toBe(1);
  });
});
