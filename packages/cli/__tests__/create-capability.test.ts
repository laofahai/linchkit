import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";
import { ScaffoldCapabilityError, scaffoldCapability } from "../src/commands/create";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-create");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

interface RunOptions {
  name: string;
  type?: string;
  category?: string;
  dir?: string;
  bare?: boolean;
}

/**
 * Direct in-process invocation of the scaffold logic. Avoids the per-test
 * cost (and parallel-load flake) of spawning `bun run <cli> create capability`
 * subprocesses — see issue #364. A separate smoke test below still spawns the
 * binary to catch wiring breaks (argument parsing, command registration, etc.).
 */
function runCreate(opts: RunOptions): { error?: ScaffoldCapabilityError; outputDir?: string } {
  try {
    const { outputDir } = scaffoldCapability({ ...opts, cwd: TEST_DIR });
    return { outputDir };
  } catch (err) {
    if (err instanceof ScaffoldCapabilityError) {
      return { error: err };
    }
    throw err;
  }
}

describe("linch create capability", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("creates expected directory structure with defaults", () => {
    const { outputDir, error } = runCreate({ name: "cap-inventory", dir: "cap-inventory" });

    expect(error).toBeUndefined();
    expect(outputDir).toBeDefined();
    const capDir = resolve(TEST_DIR, "cap-inventory");
    expect(outputDir).toBe(capDir);

    // Verify files exist
    expect(existsSync(resolve(capDir, "capability.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "package.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/index.ts"))).toBe(true);
    // New directories
    expect(existsSync(resolve(capDir, "src/schemas"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/actions"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/rules"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/states"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/views"))).toBe(true);
    // README files for empty directories
    expect(existsSync(resolve(capDir, "src/rules/README.md"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/states/README.md"))).toBe(true);
  });

  test("generates example files by default", () => {
    runCreate({ name: "cap-inventory", dir: "cap-inventory" });

    const capDir = resolve(TEST_DIR, "cap-inventory");

    // Example schema
    expect(existsSync(resolve(capDir, "src/schemas/inventory.ts"))).toBe(true);
    const schemaContent = readFileSync(resolve(capDir, "src/schemas/inventory.ts"), "utf-8");
    expect(schemaContent).toContain("defineEntity");
    expect(schemaContent).toContain("inventorySchema");

    // Example action
    expect(existsSync(resolve(capDir, "src/actions/create-inventory.ts"))).toBe(true);
    const actionContent = readFileSync(resolve(capDir, "src/actions/create-inventory.ts"), "utf-8");
    expect(actionContent).toContain("defineAction");
    expect(actionContent).toContain("create_inventory");

    // Example views
    expect(existsSync(resolve(capDir, "src/views/inventory.ts"))).toBe(true);
    const viewContent = readFileSync(resolve(capDir, "src/views/inventory.ts"), "utf-8");
    expect(viewContent).toContain("inventoryListView");
    expect(viewContent).toContain("inventoryFormView");
  });

  test("--bare skips example files", () => {
    runCreate({ name: "cap-bare", dir: "cap-bare", bare: true });

    const capDir = resolve(TEST_DIR, "cap-bare");

    // Should have .gitkeep instead of examples
    expect(existsSync(resolve(capDir, "src/schemas/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/actions/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(capDir, "src/views/.gitkeep"))).toBe(true);

    // index.ts should have empty arrays
    const indexContent = readFileSync(resolve(capDir, "src/index.ts"), "utf-8");
    expect(indexContent).toContain("schemas: []");
    expect(indexContent).toContain("actions: []");
    expect(indexContent).toContain("views: []");
  });

  test("capability.json passes validateCapabilityMetadata", () => {
    runCreate({ name: "cap-test-valid", dir: "cap-test-valid" });

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

  test("respects custom --type and --category", () => {
    runCreate({
      name: "cap-mcp-adapter",
      type: "adapter",
      category: "integration",
      dir: "cap-mcp-adapter",
    });

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

  test("package.json has correct name and peer dependency", () => {
    runCreate({ name: "cap-billing", dir: "cap-billing" });

    const capDir = resolve(TEST_DIR, "cap-billing");
    const raw = readFileSync(resolve(capDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.name).toBe("@linchkit/cap-billing");
    expect(parsed.peerDependencies["@linchkit/core"]).toBe("workspace:*");
    expect(parsed.type).toBe("module");
  });

  test("src/index.ts exports capability definition", () => {
    runCreate({ name: "cap-check", dir: "cap-check", bare: true });

    const capDir = resolve(TEST_DIR, "cap-check");
    const content = readFileSync(resolve(capDir, "src/index.ts"), "utf-8");

    expect(content).toContain('import type { CapabilityDefinition } from "@linchkit/core"');
    // Variable name is derived from sanitized capability name (hyphens → underscores)
    expect(content).toContain("cap_check: CapabilityDefinition");
    expect(content).toContain('"cap-check"');
  });

  test("fails if directory already exists", () => {
    mkdirSync(resolve(TEST_DIR, "cap-exists"), { recursive: true });

    const { error } = runCreate({ name: "cap-exists", dir: "cap-exists" });

    expect(error).toBeDefined();
    expect(error?.code).toBe("DIRECTORY_EXISTS");
    expect(error?.message).toContain("already exists");
  });

  test("rejects invalid type", () => {
    const { error } = runCreate({ name: "cap-bad", type: "invalid", dir: "cap-bad" });

    expect(error).toBeDefined();
    expect(error?.code).toBe("INVALID_TYPE");
    expect(error?.message).toContain("Invalid type");
  });

  test("rejects invalid category", () => {
    const { error } = runCreate({ name: "cap-bad", category: "invalid", dir: "cap-bad" });

    expect(error).toBeDefined();
    expect(error?.code).toBe("INVALID_CATEGORY");
    expect(error?.message).toContain("Invalid category");
  });

  test("structure output mentions views/ and states/ directories", () => {
    const { outputDir } = runCreate({ name: "cap-output", dir: "cap-output" });
    expect(outputDir).toBeDefined();

    const { structureLines } = scaffoldCapability({
      name: "cap-output-2",
      dir: "cap-output-2",
      cwd: TEST_DIR,
    });
    const joined = structureLines.join("\n");
    expect(joined).toContain("views/");
    expect(joined).toContain("states/");
  });

  test("structure output uses the actual folder name (basename of outputDir)", () => {
    // Default layout places the cap at `addons/<name>/cap-<name>/` so the
    // visualization root should match `cap-<name>`, not `<name>`.
    const { structureLines } = scaffoldCapability({
      name: "cap-vis-default",
      cwd: TEST_DIR,
    });
    expect(structureLines.join("\n")).toContain("cap-cap-vis-default/");

    // Custom --dir layout should also render the actual basename.
    const { structureLines: customLines } = scaffoldCapability({
      name: "cap-vis-custom",
      dir: "deep/nested/my-folder",
      cwd: TEST_DIR,
    });
    expect(customLines.join("\n")).toContain("my-folder/");
  });

  test("tsconfig extends path is correct for default 3-level-deep layout", () => {
    scaffoldCapability({ name: "cap-tsconfig-default", cwd: TEST_DIR });
    const tsconfigPath = resolve(
      TEST_DIR,
      "addons",
      "cap-tsconfig-default",
      "cap-cap-tsconfig-default",
      "tsconfig.json",
    );
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    // 3 levels up from addons/<name>/cap-<name>/ → repo root tsconfig.
    expect(tsconfig.extends).toBe("../../../tsconfig.json");
  });

  test("tsconfig extends path adapts to custom --dir depth", () => {
    scaffoldCapability({
      name: "cap-tsconfig-flat",
      dir: "cap-tsconfig-flat",
      cwd: TEST_DIR,
    });
    const flat = JSON.parse(
      readFileSync(resolve(TEST_DIR, "cap-tsconfig-flat", "tsconfig.json"), "utf8"),
    );
    // 1 level up from <root>/cap-tsconfig-flat/ → root tsconfig.
    expect(flat.extends).toBe("../tsconfig.json");

    scaffoldCapability({
      name: "cap-tsconfig-deep",
      dir: "deep/very/deep/cap-folder",
      cwd: TEST_DIR,
    });
    const deep = JSON.parse(
      readFileSync(
        resolve(TEST_DIR, "deep", "very", "deep", "cap-folder", "tsconfig.json"),
        "utf8",
      ),
    );
    expect(deep.extends).toBe("../../../../tsconfig.json");
  });
});

describe("linch create capability (CLI subprocess smoke)", () => {
  // One subprocess test to verify wiring (argument parsing, command
  // registration in src/index.ts). Has a generous timeout because Bun cold
  // start under parallel load can be slow; this single invocation isn't the
  // pattern that caused #364 (eleven concurrent spawns) so it stays.
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  test("spawned CLI creates the capability and reports success", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "create", "capability", "cap-smoke", "--dir", "cap-smoke"],
      {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Capability created successfully!");
    expect(existsSync(resolve(TEST_DIR, "cap-smoke/capability.json"))).toBe(true);
  }, 15_000);
});
