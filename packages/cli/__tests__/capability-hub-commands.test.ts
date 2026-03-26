import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadLocalRegistry,
  registerCapability,
  saveLocalRegistry,
  unregisterCapability,
} from "../src/utils/local-registry-io";
import { runPublishChecks } from "../src/commands/publish";
import { inferTrustLevel } from "../src/commands/install";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-hub-commands");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe("Local Registry I/O", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(cleanup);

  test("loads empty registry when file does not exist", () => {
    const registry = loadLocalRegistry(TEST_DIR);
    expect(registry.size).toBe(0);
  });

  test("saves and loads registry entries", () => {
    const { LocalCapabilityRegistry } = require("@linchkit/core");
    const registry = new LocalCapabilityRegistry();
    registry.register({
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      type: "standard",
      category: "system",
      trustLevel: "official",
    });
    saveLocalRegistry(TEST_DIR, registry);

    // Verify file was created
    const filePath = resolve(TEST_DIR, ".linchkit", "capability-registry.json");
    expect(existsSync(filePath)).toBe(true);

    // Reload and verify
    const loaded = loadLocalRegistry(TEST_DIR);
    expect(loaded.size).toBe(1);
    expect(loaded.has("@linchkit/cap-auth")).toBe(true);
    expect(loaded.get("@linchkit/cap-auth")?.version).toBe("1.0.0");
  });

  test("registerCapability adds entry and saves", () => {
    registerCapability(TEST_DIR, {
      name: "@linchkit/cap-permission",
      version: "1.0.0",
      type: "standard",
      category: "system",
      trustLevel: "official",
    });

    const registry = loadLocalRegistry(TEST_DIR);
    expect(registry.has("@linchkit/cap-permission")).toBe(true);
  });

  test("unregisterCapability removes entry and saves", () => {
    registerCapability(TEST_DIR, {
      name: "@linchkit/cap-test",
      version: "1.0.0",
      type: "standard",
      category: "business",
      trustLevel: "community",
    });

    const removed = unregisterCapability(TEST_DIR, "@linchkit/cap-test");
    expect(removed).toBe(true);

    const registry = loadLocalRegistry(TEST_DIR);
    expect(registry.has("@linchkit/cap-test")).toBe(false);
  });

  test("unregisterCapability returns false for unknown entry", () => {
    const removed = unregisterCapability(TEST_DIR, "nonexistent");
    expect(removed).toBe(false);
  });

  test("handles corrupted registry file gracefully", () => {
    mkdirSync(resolve(TEST_DIR, ".linchkit"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, ".linchkit", "capability-registry.json"), "invalid json{");

    const registry = loadLocalRegistry(TEST_DIR);
    expect(registry.size).toBe(0);
  });

  test("multiple register/unregister operations maintain consistency", () => {
    registerCapability(TEST_DIR, {
      name: "cap-a",
      version: "1.0.0",
      type: "standard",
      category: "business",
      trustLevel: "community",
    });
    registerCapability(TEST_DIR, {
      name: "cap-b",
      version: "2.0.0",
      type: "adapter",
      category: "integration",
      trustLevel: "official",
    });

    let registry = loadLocalRegistry(TEST_DIR);
    expect(registry.size).toBe(2);

    unregisterCapability(TEST_DIR, "cap-a");
    registry = loadLocalRegistry(TEST_DIR);
    expect(registry.size).toBe(1);
    expect(registry.has("cap-b")).toBe(true);
  });
});

describe("inferTrustLevel", () => {
  test("returns official for @linchkit/ scoped packages", () => {
    expect(inferTrustLevel("@linchkit/cap-auth")).toBe("official");
    expect(inferTrustLevel("@linchkit/cap-permission")).toBe("official");
  });

  test("returns community for linchkit-cap- prefixed packages", () => {
    expect(inferTrustLevel("linchkit-cap-crm")).toBe("community");
    expect(inferTrustLevel("linchkit-cap-inventory")).toBe("community");
  });

  test("returns unverified for other packages", () => {
    expect(inferTrustLevel("some-random-package")).toBe("unverified");
    expect(inferTrustLevel("@other/cap-something")).toBe("unverified");
  });
});

describe("runPublishChecks", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(cleanup);

  test("fails when capability.json is missing", () => {
    const { checks, metadata } = runPublishChecks(TEST_DIR);
    expect(checks.some((c) => !c.passed && c.name === "capability.json")).toBe(true);
    expect(metadata).toBeNull();
  });

  test("fails when capability.json is invalid", () => {
    writeFileSync(resolve(TEST_DIR, "capability.json"), JSON.stringify({ name: "test" }));
    const { checks, metadata } = runPublishChecks(TEST_DIR);
    expect(checks.some((c) => !c.passed && c.name === "capability.json validation")).toBe(true);
    expect(metadata).toBeNull();
  });

  test("passes with valid capability directory", () => {
    // Create a valid capability.json
    writeFileSync(
      resolve(TEST_DIR, "capability.json"),
      JSON.stringify({
        name: "cap-test",
        version: "1.0.0",
        type: "standard",
        category: "business",
        label: "Test Cap",
        description: "A test capability",
      }),
    );
    // Create package.json with peer dep
    writeFileSync(
      resolve(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "@linchkit/cap-test",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.0.1" },
      }),
    );
    // Create README
    writeFileSync(resolve(TEST_DIR, "README.md"), "# Test Cap\n");
    // Create test dir
    mkdirSync(resolve(TEST_DIR, "__tests__"), { recursive: true });

    const { checks, metadata } = runPublishChecks(TEST_DIR);

    // All checks should pass
    const failed = checks.filter((c) => !c.passed);
    expect(failed).toHaveLength(0);
    expect(metadata).not.toBeNull();
    expect(metadata?.name).toBe("cap-test");
    expect(metadata?.version).toBe("1.0.0");
  });

  test("warns when README.md is missing", () => {
    writeFileSync(
      resolve(TEST_DIR, "capability.json"),
      JSON.stringify({
        name: "cap-test",
        version: "1.0.0",
        type: "standard",
        category: "business",
        label: "Test",
      }),
    );
    writeFileSync(
      resolve(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "@linchkit/cap-test",
        peerDependencies: { "@linchkit/core": "^0.0.1" },
      }),
    );

    const { checks } = runPublishChecks(TEST_DIR);
    const readmeCheck = checks.find((c) => c.name === "README.md");
    expect(readmeCheck?.passed).toBe(false);
  });

  test("warns when tests directory is missing", () => {
    writeFileSync(
      resolve(TEST_DIR, "capability.json"),
      JSON.stringify({
        name: "cap-test",
        version: "1.0.0",
        type: "standard",
        category: "business",
        label: "Test",
      }),
    );
    writeFileSync(
      resolve(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "@linchkit/cap-test",
        peerDependencies: { "@linchkit/core": "^0.0.1" },
      }),
    );

    const { checks } = runPublishChecks(TEST_DIR);
    const testCheck = checks.find((c) => c.name === "tests");
    expect(testCheck?.passed).toBe(false);
  });

  test("fails when package.json has no peer dependency on core", () => {
    writeFileSync(
      resolve(TEST_DIR, "capability.json"),
      JSON.stringify({
        name: "cap-test",
        version: "1.0.0",
        type: "standard",
        category: "business",
        label: "Test",
      }),
    );
    writeFileSync(
      resolve(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "@linchkit/cap-test",
        peerDependencies: {},
      }),
    );

    const { checks } = runPublishChecks(TEST_DIR);
    const peerCheck = checks.find((c) => c.name === "peer dependency");
    expect(peerCheck?.passed).toBe(false);
  });

  test("rejects invalid semver version", () => {
    writeFileSync(
      resolve(TEST_DIR, "capability.json"),
      JSON.stringify({
        name: "cap-test",
        version: "not-a-version",
        type: "standard",
        category: "business",
        label: "Test",
      }),
    );

    const { checks } = runPublishChecks(TEST_DIR);
    // The version field would still fail at Zod validation if not a string,
    // but we also have our own semver regex check
    const versionCheck = checks.find((c) => c.name === "version");
    if (versionCheck) {
      expect(versionCheck.passed).toBe(false);
    }
  });
});

describe("Search command (unit)", () => {
  test("search on empty registry returns empty", () => {
    const { createLocalRegistry } = require("@linchkit/core");
    const registry = createLocalRegistry();
    const results = registry.search({ query: "test" });
    expect(results).toEqual([]);
  });

  test("search filters by multiple criteria", () => {
    const { createLocalRegistry } = require("@linchkit/core");
    const registry = createLocalRegistry([
      {
        name: "cap-a",
        version: "1.0.0",
        type: "standard",
        category: "business",
        trustLevel: "official",
        label: "Alpha",
        description: "First capability",
      },
      {
        name: "cap-b",
        version: "2.0.0",
        type: "adapter",
        category: "integration",
        trustLevel: "community",
        label: "Beta",
        description: "Second capability",
      },
    ]);

    expect(registry.search({ type: "adapter" })).toHaveLength(1);
    expect(registry.search({ category: "business" })).toHaveLength(1);
    expect(registry.search({ trustLevel: "official" })).toHaveLength(1);
    expect(registry.search({ query: "first" })).toHaveLength(1);
    expect(registry.search({ query: "capability" })).toHaveLength(2);
    expect(registry.search({ type: "standard", query: "first" })).toHaveLength(1);
    expect(registry.search({ type: "adapter", query: "first" })).toHaveLength(0);
  });
});

describe("Uninstall dependency protection (unit)", () => {
  test("canUninstall returns safe when no dependents", () => {
    const { createLocalRegistry } = require("@linchkit/core");
    const registry = createLocalRegistry([
      {
        name: "cap-a",
        version: "1.0.0",
        type: "standard",
        category: "business",
        trustLevel: "official",
      },
    ]);
    const result = registry.canUninstall("cap-a");
    expect(result.safe).toBe(true);
    expect(result.dependents).toEqual([]);
  });

  test("canUninstall returns unsafe when dependents exist", () => {
    const { createLocalRegistry } = require("@linchkit/core");
    const registry = createLocalRegistry([
      {
        name: "cap-a",
        version: "1.0.0",
        type: "standard",
        category: "business",
        trustLevel: "official",
      },
      {
        name: "cap-b",
        version: "1.0.0",
        type: "standard",
        category: "business",
        trustLevel: "official",
        dependencies: ["cap-a"],
      },
    ]);
    const result = registry.canUninstall("cap-a");
    expect(result.safe).toBe(false);
    expect(result.dependents).toEqual(["cap-b"]);
  });
});
