import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  detectDependencyCycle,
  loadCapabilityMetadata,
  validateTypeCompatibility,
} from "../src/commands/install-utils";

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

  describe("DAG cycle detection", () => {
    test("returns null when there are no cycles", () => {
      const deps: Record<string, string[]> = {
        A: ["B", "C"],
        B: ["D"],
        C: [],
        D: [],
      };
      const result = detectDependencyCycle("A", (name) => deps[name] ?? []);
      expect(result).toBeNull();
    });

    test("detects a simple two-node cycle", () => {
      const deps: Record<string, string[]> = {
        A: ["B"],
        B: ["A"],
      };
      const result = detectDependencyCycle("A", (name) => deps[name] ?? []);
      expect(result).not.toBeNull();
      expect(result).toContain("A");
      expect(result).toContain("B");
    });

    test("detects a longer cycle", () => {
      const deps: Record<string, string[]> = {
        A: ["B"],
        B: ["C"],
        C: ["D"],
        D: ["B"], // cycle: B -> C -> D -> B
      };
      const result = detectDependencyCycle("A", (name) => deps[name] ?? []);
      expect(result).not.toBeNull();
      expect(result).toContain("B");
      expect(result).toContain("C");
      expect(result).toContain("D");
    });

    test("detects self-dependency cycle", () => {
      const deps: Record<string, string[]> = {
        A: ["A"],
      };
      const result = detectDependencyCycle("A", (name) => deps[name] ?? []);
      expect(result).not.toBeNull();
      expect(result).toEqual(["A", "A"]);
    });

    test("handles empty dependencies", () => {
      const result = detectDependencyCycle("A", () => []);
      expect(result).toBeNull();
    });
  });

  describe("type compatibility validation", () => {
    test("adapter cannot depend on another adapter", () => {
      const meta = {
        name: "cap-a",
        version: "1.0.0",
        type: "adapter" as const,
        category: "integration",
        label: "Adapter A",
        dependencies: ["cap-b"],
      };
      const depMeta = {
        name: "cap-b",
        version: "1.0.0",
        type: "adapter" as const,
        category: "integration",
        label: "Adapter B",
      };

      const result = validateTypeCompatibility(meta, (name) => (name === "cap-b" ? depMeta : null));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("cannot depend on adapter");
    });

    test("adapter can depend on standard capability", () => {
      const meta = {
        name: "cap-a",
        version: "1.0.0",
        type: "adapter" as const,
        category: "integration",
        label: "Adapter A",
        dependencies: ["cap-b"],
      };
      const depMeta = {
        name: "cap-b",
        version: "1.0.0",
        type: "standard" as const,
        category: "business",
        label: "Standard B",
      };

      const result = validateTypeCompatibility(meta, (name) => (name === "cap-b" ? depMeta : null));
      expect(result.errors.length).toBe(0);
    });

    test("bridge without standard dep gets a warning", () => {
      const meta = {
        name: "cap-bridge",
        version: "1.0.0",
        type: "bridge" as const,
        category: "business",
        label: "Bridge",
        dependencies: ["cap-other-bridge"],
      };
      const depMeta = {
        name: "cap-other-bridge",
        version: "1.0.0",
        type: "bridge" as const,
        category: "business",
        label: "Other Bridge",
      };

      const result = validateTypeCompatibility(meta, (name) =>
        name === "cap-other-bridge" ? depMeta : null,
      );
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("does not depend on any standard capability");
    });

    test("no deps returns no errors or warnings", () => {
      const meta = {
        name: "cap-a",
        version: "1.0.0",
        type: "standard" as const,
        category: "business",
        label: "A",
        dependencies: [],
      };
      const result = validateTypeCompatibility(meta, () => null);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });
  });

  describe("loadCapabilityMetadata", () => {
    test("loads and validates a valid capability.json", () => {
      createFakePackage("@linchkit/cap-test", validCapability);
      const path = resolve(TEST_DIR, "node_modules", "@linchkit/cap-test", "capability.json");
      const meta = loadCapabilityMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta?.name).toBe("@linchkit/cap-test");
    });

    test("returns null for nonexistent path", () => {
      const meta = loadCapabilityMetadata("/nonexistent/capability.json");
      expect(meta).toBeNull();
    });

    test("returns null for invalid capability.json", () => {
      createFakePackage("bad-cap");
      const badPath = resolve(TEST_DIR, "node_modules", "bad-cap", "capability.json");
      writeFileSync(badPath, JSON.stringify({ name: "bad" })); // Missing required fields
      const meta = loadCapabilityMetadata(badPath);
      expect(meta).toBeNull();
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

    test("--dry-run shows preview for local capability", async () => {
      // Create a local capability so dry-run can read its capability.json
      createLocalCapability("my-cap", validCapability);

      const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "install", "./my-cap", "--dry-run"], {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });

      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = stdout + stderr;

      expect(output).toContain("Dry run mode");
      expect(output).toContain("Would install capability");
      expect(output).toContain("Test Capability");
    }, 30_000);

    test("exits with error for a nonexistent package", async () => {
      // Override the npm registry to an unreachable address so `bun add` fails
      // fast with ConnectionRefused instead of waiting on the live npm registry
      // (which can hang and cause flaky timeouts). This still exercises the
      // real failure path: bun add returns non-zero, install.ts calls
      // process.exit(1), and the CLI exits with a non-zero code.
      //
      // We do NOT rely on `BUN_CONFIG_REGISTRY=...:1` being inherently
      // fail-fast — past Bun releases shipped hangs against unreachable
      // registries (oven-sh/bun#5831, #11526) and CI pins `bun-version: latest`,
      // so a future regression could quietly turn this back into a 30s
      // timeout flake. The kill-timer below caps the spawn at 8s regardless:
      // a killed process exits non-zero, which is what the assertion checks,
      // so the test stays deterministic whether `bun add` exits cleanly or
      // hangs. The test budget (15s) leaves headroom for cold CI startup.
      const proc = Bun.spawn(
        ["bun", "run", CLI_ENTRY, "install", "@linchkit/this-package-does-not-exist-xyz"],
        {
          cwd: TEST_DIR,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            BUN_CONFIG_REGISTRY: "http://127.0.0.1:1",
          },
        },
      );

      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, 8_000);

      try {
        const exitCode = await proc.exited;
        // `bun add` should fail with ECONNREFUSED in well under 1s. If the
        // kill-timer ever fires, the spawn will still exit non-zero (a
        // killed process satisfies the "should fail" assertion), but that
        // means `bun add` blocked instead of failing fast — exactly the
        // Bun regression mode we want to surface (oven-sh/bun#5831,
        // #11526). Throw a descriptive error instead of silently passing,
        // so the regression doesn't hide behind a green test.
        expect(exitCode).not.toBe(0);
        if (timedOut) {
          throw new Error(
            "bun add did not fail fast against an unreachable registry — " +
              "the 8s kill-timer fired. This may indicate a Bun regression " +
              "(oven-sh/bun#5831, #11526). Investigate before merging.",
          );
        }
      } finally {
        clearTimeout(killTimer);
      }
    }, 15_000);
  });
});
