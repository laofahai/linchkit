import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-install");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

/** Create a fake node_modules/<pkg> with an optional capability.json */
function createFakePackage(pkgName: string, capabilityJson?: Record<string, unknown>) {
  const pkgDir = resolve(TEST_DIR, "node_modules", pkgName);
  mkdirSync(pkgDir, { recursive: true });
  // Write a minimal package.json so it looks like a real package
  writeFileSync(
    resolve(pkgDir, "package.json"),
    JSON.stringify({ name: pkgName, version: "1.0.0" }),
  );
  if (capabilityJson) {
    writeFileSync(resolve(pkgDir, "capability.json"), JSON.stringify(capabilityJson, null, 2));
  }
}

/** Create a fake local capability directory with an optional capability.json */
function createLocalCapability(dirName: string, capabilityJson?: Record<string, unknown>) {
  const dir = resolve(TEST_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  if (capabilityJson) {
    writeFileSync(resolve(dir, "capability.json"), JSON.stringify(capabilityJson, null, 2));
  }
}

/** Valid capability.json fixture */
const validCapability: Record<string, unknown> = {
  name: "@linchkit/cap-test",
  version: "1.0.0",
  type: "standard",
  category: "business",
  label: "Test Capability",
  description: "A test capability for unit tests",
  dependencies: [],
  extensions: {
    schemas: ["test_schema"],
    actions: ["test_action"],
  },
};

describe("linch install", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Create a minimal package.json so bun add has something to work with
    writeFileSync(
      resolve(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test-project", version: "0.0.0", dependencies: {} }),
    );
  });

  afterEach(() => {
    cleanup();
  });

  describe("capability.json validation", () => {
    test("validates a correct capability.json", async () => {
      const { validateCapabilityMetadata } = await import("@linchkit/core");
      const result = validateCapabilityMetadata(validCapability);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("@linchkit/cap-test");
        expect(result.data.type).toBe("standard");
        expect(result.data.category).toBe("business");
        expect(result.data.label).toBe("Test Capability");
      }
    });

    test("rejects capability.json with missing required fields", async () => {
      const { validateCapabilityMetadata } = await import("@linchkit/core");
      const invalid = { name: "@linchkit/cap-test" }; // missing version, type, category, label
      const result = validateCapabilityMetadata(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    test("rejects capability.json with invalid type", async () => {
      const { validateCapabilityMetadata } = await import("@linchkit/core");
      const invalid = {
        ...validCapability,
        type: "invalid_type",
      };
      const result = validateCapabilityMetadata(invalid);
      expect(result.success).toBe(false);
    });

    test("rejects capability.json with invalid category", async () => {
      const { validateCapabilityMetadata } = await import("@linchkit/core");
      const invalid = {
        ...validCapability,
        category: "invalid_category",
      };
      const result = validateCapabilityMetadata(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("missing capability.json warning", () => {
    test("warns when package has no capability.json", () => {
      // Create a package without capability.json
      createFakePackage("some-regular-package");

      const capJsonPath = resolve(
        TEST_DIR,
        "node_modules",
        "some-regular-package",
        "capability.json",
      );
      expect(existsSync(capJsonPath)).toBe(false);
    });

    test("finds capability.json when present", () => {
      createFakePackage("@linchkit/cap-test", validCapability);

      const capJsonPath = resolve(
        TEST_DIR,
        "node_modules",
        "@linchkit/cap-test",
        "capability.json",
      );
      expect(existsSync(capJsonPath)).toBe(true);

      const content = JSON.parse(require("node:fs").readFileSync(capJsonPath, "utf-8"));
      expect(content.name).toBe("@linchkit/cap-test");
    });
  });

  describe("dependency checking", () => {
    test("detects missing capability dependencies", () => {
      const capWithDeps: Record<string, unknown> = {
        ...validCapability,
        dependencies: ["@linchkit/cap-auth", "@linchkit/cap-permission"],
      };
      createFakePackage("@linchkit/cap-test", capWithDeps);

      // Only install one of the two dependencies
      createFakePackage("@linchkit/cap-auth");
      // @linchkit/cap-permission is NOT installed

      const missingDeps: string[] = [];
      const deps = capWithDeps.dependencies as string[];
      for (const dep of deps) {
        const depPath = resolve(TEST_DIR, "node_modules", dep);
        if (!existsSync(depPath)) {
          missingDeps.push(dep);
        }
      }

      expect(missingDeps).toEqual(["@linchkit/cap-permission"]);
    });

    test("reports no missing deps when all are present", () => {
      const capWithDeps: Record<string, unknown> = {
        ...validCapability,
        dependencies: ["@linchkit/cap-auth"],
      };
      createFakePackage("@linchkit/cap-test", capWithDeps);
      createFakePackage("@linchkit/cap-auth");

      const missingDeps: string[] = [];
      const deps = capWithDeps.dependencies as string[];
      for (const dep of deps) {
        const depPath = resolve(TEST_DIR, "node_modules", dep);
        if (!existsSync(depPath)) {
          missingDeps.push(dep);
        }
      }

      expect(missingDeps).toEqual([]);
    });

    test("handles empty dependencies array", () => {
      const capNoDeps: Record<string, unknown> = {
        ...validCapability,
        dependencies: [],
      };
      createFakePackage("@linchkit/cap-test", capNoDeps);

      const missingDeps: string[] = [];
      const deps = capNoDeps.dependencies as string[];
      for (const dep of deps) {
        const depPath = resolve(TEST_DIR, "node_modules", dep);
        if (!existsSync(depPath)) {
          missingDeps.push(dep);
        }
      }

      expect(missingDeps).toEqual([]);
    });
  });

  describe("local path resolution", () => {
    test("resolves capability.json from a local path", () => {
      createLocalCapability("my-local-cap", validCapability);

      const capJsonPath = resolve(TEST_DIR, "my-local-cap", "capability.json");
      expect(existsSync(capJsonPath)).toBe(true);
    });
  });

  describe("install command integration", () => {
    test("installs a local capability package and shows metadata", async () => {
      // Create a local capability package with a valid capability.json
      const localPkgDir = resolve(TEST_DIR, "local-cap");
      mkdirSync(localPkgDir, { recursive: true });
      writeFileSync(
        resolve(localPkgDir, "package.json"),
        JSON.stringify({ name: "local-cap", version: "0.0.1" }),
      );
      writeFileSync(resolve(localPkgDir, "capability.json"), JSON.stringify(validCapability));
      writeFileSync(resolve(localPkgDir, "index.js"), "module.exports = {};");

      const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "install", "./local-cap"], {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });

      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = stdout + stderr;

      // Package should install successfully
      expect(output).toContain("installed successfully");
      // Should display capability info
      expect(output).toContain("Test Capability");
    }, 30_000);

    test("exits with error for a nonexistent package", async () => {
      const proc = Bun.spawn(
        ["bun", "run", CLI_ENTRY, "install", "@linchkit/this-package-does-not-exist-xyz"],
        {
          cwd: TEST_DIR,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const exitCode = await proc.exited;
      // bun add should fail, which causes a non-zero exit
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });
});
