import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractImportSpecifiers,
  lintCapability,
  stripComments,
} from "../src/methodology/capability-lint";

// -- Fixture helpers -----------------------------------------------------

const tmpRoots: string[] = [];

function makeCapDir(prefix = "caplint-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

const VALID_CAPABILITY_JSON = {
  name: "@linchkit/cap-sample",
  version: "1.0.0",
  type: "standard",
  category: "business",
  label: "Sample Capability",
};

/**
 * A package.json that satisfies the core-version check: declares
 * `@linchkit/core` as a peerDependency and a matching `coreVersion`. Used by
 * fixtures that exercise OTHER checks and must otherwise be fully clean.
 */
function writeCorePackageJson(root: string, coreRange = "^0.2.0"): void {
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "@linchkit/cap-sample",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": coreRange },
      linchkit: { coreVersion: coreRange },
    }),
  );
}

/**
 * Build a synthetic monorepo whose root contains `packages/core/package.json`
 * pinned to `coreVersion`, with a capability nested under
 * `addons/<group>/<cap>/`. Returns the capability dir so the lint's walk-up
 * version resolution finds the controllable local core version. Used by the
 * satisfaction-check tests, which need a resolvable local core version (a plain
 * tmpdir fixture has none, so the satisfaction check is skipped there).
 */
function makeMonorepoCapDir(coreVersion: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "caplint-mono-"));
  tmpRoots.push(repoRoot);
  writeFile(
    repoRoot,
    "packages/core/package.json",
    JSON.stringify({ name: "@linchkit/core", version: coreVersion }),
  );
  const capDir = join(repoRoot, "addons", "sample", "cap-sample");
  mkdirSync(join(capDir, "src"), { recursive: true });
  return capDir;
}

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Tests ---------------------------------------------------------------

describe("lintCapability", () => {
  it("returns ok for a clean capability (valid manifest + core barrel import + test)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeCorePackageJson(root);
    writeFile(root, "src/index.ts", `import { defineEntity } from "@linchkit/core";\nexport {};\n`);
    writeFile(
      root,
      "__tests__/x.test.ts",
      `import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`,
    );

    const result = lintCapability(root);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("accepts package.json linchkit field as a manifest fallback", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-fallback",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "adapter", category: "integration", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(
      root,
      "src/index.ts",
      `import { defineCapability } from "@linchkit/core";\nexport {};\n`,
    );
    writeFile(root, "src/foo.test.ts", `import { test } from "bun:test";\ntest("ok", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.check === "metadata")).toHaveLength(0);
  });

  it("reports a metadata error when no manifest exists", () => {
    const root = makeCapDir();
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\n`);
    writeFile(root, "src/y.test.ts", `import { test } from "bun:test";\ntest("y", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const metaIssues = result.issues.filter((i) => i.check === "metadata");
    expect(metaIssues).toHaveLength(1);
    expect(metaIssues[0]?.level).toBe("error");
    expect(metaIssues[0]?.message).toContain("No capability.json or package.json");
  });

  it("reports a metadata error for an invalid manifest (missing required fields)", () => {
    const root = makeCapDir();
    // Missing type/category/label.
    writeFile(
      root,
      "capability.json",
      JSON.stringify({ name: "@linchkit/cap-bad", version: "1.0.0" }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\n`);
    writeFile(root, "src/z.test.ts", `import { test } from "bun:test";\ntest("z", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const metaIssues = result.issues.filter((i) => i.check === "metadata");
    expect(metaIssues.length).toBeGreaterThan(0);
    expect(metaIssues.every((i) => i.level === "error")).toBe(true);
    // Each missing field is reported separately.
    const fields = metaIssues.map((i) => i.message);
    expect(fields.some((m) => m.includes("type"))).toBe(true);
    expect(fields.some((m) => m.includes("category"))).toBe(true);
  });

  it("reports a metadata error for malformed JSON", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", "{ not valid json ");
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const metaIssues = result.issues.filter((i) => i.check === "metadata");
    expect(metaIssues).toHaveLength(1);
    expect(metaIssues[0]?.message).toContain("Failed to parse capability.json");
  });

  it("flags a deep @linchkit/core/src import (import-boundary error)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core/src/engine/foo";\n`);
    writeFile(root, "src/b.test.ts", `import { test } from "bun:test";\ntest("b", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const boundary = result.issues.filter((i) => i.check === "import-boundary");
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.level).toBe("error");
    expect(boundary[0]?.message).toContain("@linchkit/core/src/engine/foo");
    expect(boundary[0]?.file).toBe("src/index.ts");
  });

  it("flags a @linchkit/core/dist import (import-boundary error)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core/dist/types";\n`);
    writeFile(root, "src/c.test.ts", `import { test } from "bun:test";\ntest("c", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.some((i) => i.check === "import-boundary" && i.level === "error")).toBe(
      true,
    );
  });

  it("does NOT flag the bare @linchkit/core barrel or public subpath imports", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeCorePackageJson(root);
    writeFile(
      root,
      "src/index.ts",
      [
        `import { defineEntity } from "@linchkit/core";`,
        `import { EntityRegistry } from "@linchkit/core/server";`,
        `import { useThing } from "@linchkit/core/client";`,
        `export {};`,
      ].join("\n"),
    );
    writeFile(root, "src/d.test.ts", `import { test } from "bun:test";\ntest("d", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "import-boundary")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("does NOT flag a deep import that only appears in comments", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeCorePackageJson(root);
    writeFile(
      root,
      "src/index.ts",
      [
        `/**`,
        ` * See @linchkit/core/src/engine/foo for the underlying engine.`,
        ` * A URL like https://example.com/path must not break stripping.`,
        ` */`,
        `// import { x } from "@linchkit/core/src/engine/bar";`,
        `import { defineEntity } from "@linchkit/core";`,
        `export {};`,
      ].join("\n"),
    );
    writeFile(root, "src/e.test.ts", `import { test } from "bun:test";\ntest("e", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "import-boundary")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("still flags a REAL deep import even when comments mention paths too", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(
      root,
      "src/index.ts",
      [
        `/** mentions @linchkit/core/src/engine/doc in prose */`,
        `// import { y } from "@linchkit/core/src/engine/commented";`,
        `import { x } from "@linchkit/core/src/engine/foo";`,
        `export {};`,
      ].join("\n"),
    );
    writeFile(root, "src/f.test.ts", `import { test } from "bun:test";\ntest("f", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const boundary = result.issues.filter((i) => i.check === "import-boundary");
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.level).toBe("error");
    expect(boundary[0]?.message).toContain("@linchkit/core/src/engine/foo");
  });

  it("does NOT flag a relative escape into a non-core sibling", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    // Escapes the capability root but the relative path has no `core` segment.
    writeFile(root, "src/x.ts", `import { a } from "../../shared/util";\nexport { a };\n`);
    writeFile(root, "src/h.test.ts", `import { test } from "bun:test";\ntest("h", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "import-boundary")).toHaveLength(0);
  });

  it("flags a relative escape into a core sibling (import-boundary error)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    // Escapes the capability root and the relative path points at `core`.
    writeFile(root, "src/x.ts", `import { a } from "../../core/internal";\nexport { a };\n`);
    writeFile(root, "src/i.test.ts", `import { test } from "bun:test";\ntest("i", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const boundary = result.issues.filter((i) => i.check === "import-boundary");
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.level).toBe("error");
    expect(boundary[0]?.message).toContain("../../core/internal");
    expect(boundary[0]?.file).toBe("src/x.ts");
  });

  it("does NOT flag a non-core escape even when an ancestor dir is named 'core'", () => {
    // Regression: the old rule tested the ABSOLUTE resolved path, so any repo
    // checked out under a `core`-named ancestor falsely flagged every escaping
    // import. The tmpdir name here contains `core` to exercise exactly that.
    const root = makeCapDir("core-host-");
    expect(root.replace(/\\/g, "/")).toContain("core");
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/x.ts", `import { a } from "../../shared/util";\nexport { a };\n`);
    writeFile(root, "src/j.test.ts", `import { test } from "bun:test";\ntest("j", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "import-boundary")).toHaveLength(0);
  });

  it("detects a multi-line deep import (regression guard for comment stripping)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(
      root,
      "src/index.ts",
      [`import {`, `  a,`, `  b,`, `} from "@linchkit/core/src/foo";`, `export {};`].join("\n"),
    );
    writeFile(root, "src/g.test.ts", `import { test } from "bun:test";\ntest("g", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const boundary = result.issues.filter((i) => i.check === "import-boundary");
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.message).toContain("@linchkit/core/src/foo");
  });

  it("reports a test-existence error when no test files are present", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const testIssues = result.issues.filter((i) => i.check === "test-existence");
    expect(testIssues).toHaveLength(1);
    expect(testIssues[0]?.level).toBe("error");
  });

  it("accepts a *.spec.ts file as satisfying test existence", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(
      root,
      "src/thing.spec.ts",
      `import { test } from "bun:test";\ntest("spec", () => {});\n`,
    );

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "test-existence")).toHaveLength(0);
  });

  // -- Check 3 (executable test content) -------------------------------

  it("accepts a test file containing a real it(...) block", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(
      root,
      "src/real.test.ts",
      `import { expect, it } from "bun:test";\nit("does a thing", () => expect(1).toBe(1));\n`,
    );

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "test-existence")).toHaveLength(0);
  });

  it("fails the basic-test check for an empty test file (no executable test)", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeCorePackageJson(root);
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    // File exists and matches the *.test.ts pattern but contains no test call.
    writeFile(root, "src/empty.test.ts", `export {};\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const testIssues = result.issues.filter((i) => i.check === "test-existence");
    expect(testIssues).toHaveLength(1);
    expect(testIssues[0]?.level).toBe("error");
    expect(testIssues[0]?.message).toContain("executable test");
  });

  it("fails the basic-test check when the only test() call is commented out", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeCorePackageJson(root);
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(
      root,
      "src/commented.test.ts",
      [
        `import { test } from "bun:test";`,
        `// test("disabled", () => {});`,
        `/* test("also disabled", () => {}); */`,
        `export {};`,
      ].join("\n"),
    );

    const result = lintCapability(root);
    const testIssues = result.issues.filter((i) => i.check === "test-existence");
    expect(testIssues).toHaveLength(1);
    expect(testIssues[0]?.level).toBe("error");
  });

  it("accepts test.only(...) and describe(...) member forms as executable tests", () => {
    const root = makeCapDir();
    writeFile(root, "capability.json", JSON.stringify(VALID_CAPABILITY_JSON));
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(
      root,
      "src/member.test.ts",
      `import { describe, test } from "bun:test";\ndescribe("suite", () => { test.only("x", () => {}); });\n`,
    );

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "test-existence")).toHaveLength(0);
  });

  // -- Check 4 (core version declaration consistency) ------------------

  it("passes when peerDep and coreVersion are present and consistent", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "core-version")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("errors when peerDep ^0.2.0 does not equal coreVersion ^0.1.0 (mismatch)", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business", coreVersion: "^0.1.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const cv = result.issues.filter((i) => i.check === "core-version" && i.level === "error");
    expect(cv).toHaveLength(1);
    expect(cv[0]?.message).toContain("^0.2.0");
    expect(cv[0]?.message).toContain("^0.1.0");
  });

  it("errors when @linchkit/core is missing from peerDependencies", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        // No peerDependencies block at all.
        linchkit: { type: "standard", category: "business", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const cv = result.issues.filter((i) => i.check === "core-version" && i.level === "error");
    expect(cv.some((i) => i.message.includes("peerDependencies"))).toBe(true);
  });

  it("errors when no coreVersion is declared anywhere", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const cv = result.issues.filter((i) => i.check === "core-version" && i.level === "error");
    expect(cv.some((i) => i.message.includes("No core-version range declared"))).toBe(true);
  });

  it("skips the equality check when peerDep is workspace:* (only requires coreVersion)", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "workspace:*" },
        linchkit: { type: "standard", category: "business", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    // No equality error despite the value differing from a concrete range.
    expect(result.issues.filter((i) => i.check === "core-version")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("accepts deprecated minCoreVersion with a migration warning (no error)", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business", minCoreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    const cv = result.issues.filter((i) => i.check === "core-version");
    expect(cv).toHaveLength(1);
    expect(cv[0]?.level).toBe("warning");
    expect(cv[0]?.message).toContain("minCoreVersion");
    // A warning does not fail the lint.
    expect(result.ok).toBe(true);
  });

  it("errors when a deprecated-only minCoreVersion mismatches a concrete peerDep", () => {
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business", minCoreVersion: "^0.1.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    // Both the deprecation warning AND the mismatch error are reported.
    const cv = result.issues.filter((i) => i.check === "core-version");
    expect(cv.some((i) => i.level === "warning")).toBe(true);
    expect(cv.some((i) => i.level === "error" && i.message.includes("mismatch"))).toBe(true);
  });

  it("prefers capability.json coreVersion over package.json linchkit.coreVersion", () => {
    const root = makeCapDir();
    // capability.json declares ^0.2.0 (the precedence source) and matches peerDep.
    // Per capabilityMetadataSchema, coreVersion is nested under `linchkit`.
    writeFile(
      root,
      "capability.json",
      JSON.stringify({ ...VALID_CAPABILITY_JSON, linchkit: { coreVersion: "^0.2.0" } }),
    );
    // package.json's linchkit.coreVersion intentionally differs; it must be ignored.
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { coreVersion: "^0.9.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "core-version")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // -- Check 4 (satisfaction of the LOCAL core version) ----------------

  it("passes when coreVersion ^0.2.0 satisfies the local core 0.2.0", () => {
    const root = makeMonorepoCapDir("0.2.0");
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { type: "standard", category: "business", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.issues.filter((i) => i.check === "core-version")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("errors when coreVersion >=0.3.0 <0.4.0 does not satisfy the local core 0.2.0", () => {
    const root = makeMonorepoCapDir("0.2.0");
    // The real cap-adapter-server skew: an AND-range that excludes the only
    // core version that exists. peerDep matches coreVersion (both wrong) so the
    // equality check passes — only the satisfaction check catches it.
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": ">=0.3.0 <0.4.0" },
        linchkit: { type: "standard", category: "business", coreVersion: ">=0.3.0 <0.4.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const cv = result.issues.filter((i) => i.check === "core-version" && i.level === "error");
    expect(cv.some((i) => /does not satisfy/.test(i.message))).toBe(true);
    const msg = cv.find((i) => /does not satisfy/.test(i.message))?.message ?? "";
    expect(msg).toContain(">=0.3.0 <0.4.0");
    expect(msg).toContain("0.2.0");
  });

  it("emits a distinct satisfaction error for a concrete peerDep that differs and fails", () => {
    const root = makeMonorepoCapDir("0.2.0");
    // The declared coreVersion (^0.2.0) DOES satisfy local core 0.2.0, so the
    // declared-range branch stays clean. The peerDep range (^0.3.0) genuinely
    // DIFFERS and does NOT satisfy 0.2.0 — this is the only scenario that
    // exercises the `peerCore !== effectiveRange` distinct-peerDep branch.
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.3.0" },
        linchkit: { type: "standard", category: "business", coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    expect(result.ok).toBe(false);
    const cv = result.issues.filter(
      (i) =>
        i.check === "core-version" && i.level === "error" && /does not satisfy/.test(i.message),
    );
    // Exactly one satisfaction error — the distinct peerDep one — fires; the
    // declared ^0.2.0 range did NOT produce an error (it satisfies 0.2.0).
    expect(cv.length).toBe(1);
    expect(cv[0]?.message).toContain('peerDependencies["@linchkit/core"]');
    expect(cv[0]?.message).toContain("^0.3.0");
  });

  it("skips the satisfaction check when the local core version is unresolvable (no crash, no error)", () => {
    // A plain tmpdir fixture has no ancestor packages/core/package.json and
    // @linchkit/core is not module-resolvable from it, so version resolution
    // returns undefined and the satisfaction check is skipped silently — even
    // for a range that could never satisfy any real core (>=0.3.0 <0.4.0).
    const root = makeCapDir();
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cv",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": ">=0.3.0 <0.4.0" },
        linchkit: { type: "standard", category: "business", coreVersion: ">=0.3.0 <0.4.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/a.test.ts", `import { test } from "bun:test";\ntest("a", () => {});\n`);

    const result = lintCapability(root);
    // No satisfaction error because the local core version could not be resolved.
    expect(result.issues.some((i) => /does not satisfy/.test(i.message))).toBe(false);
    // peerDep equals coreVersion → the equality check also passes → fully clean.
    expect(result.issues.filter((i) => i.check === "core-version")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

describe("stripComments", () => {
  it("preserves `//` inside a double-quoted string", () => {
    const src = `const msg = "Choose // to proceed";`;
    expect(stripComments(src)).toBe(src);
  });

  it("preserves `//` inside a single-quoted string", () => {
    const src = `const msg = 'a // b';`;
    expect(stripComments(src)).toBe(src);
  });

  it("preserves `//` inside a template literal", () => {
    const src = "const t = `a // b`;";
    expect(stripComments(src)).toBe(src);
  });

  it("preserves `//` inside a regex literal", () => {
    const src = `const re = /^\\/\\//;`;
    expect(stripComments(src)).toBe(src);
  });

  it("preserves https:// inside a string (URL guard regression)", () => {
    const src = `const url = "https://example.com/path";`;
    expect(stripComments(src)).toBe(src);
  });

  it("strips a genuine line comment AFTER a string literal on the same line", () => {
    const stripped = stripComments(`const msg = "a // b"; // real comment`);
    expect(stripped).toContain(`"a // b"`);
    expect(stripped).not.toContain("real comment");
  });

  it("removes a single-line block comment, keeping surrounding code", () => {
    const stripped = stripComments(`const a = 1; /* gone */ const b = 2;`);
    expect(stripped).not.toContain("gone");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const b = 2;");
  });

  it("removes a multi-line block comment", () => {
    const stripped = stripComments(["before", "/* line one", " line two */", "after"].join("\n"));
    expect(stripped).not.toContain("line one");
    expect(stripped).not.toContain("line two");
    expect(stripped).toContain("before");
    expect(stripped).toContain("after");
  });

  it("strips a line comment after a division expression (not a regex)", () => {
    const stripped = stripComments(`const x = a / b; // gone`);
    expect(stripped).toContain("a / b");
    expect(stripped).not.toContain("gone");
  });

  it("does not end a string at an escaped quote", () => {
    const src = `const s = "a \\" // still string";`;
    // The `//` lives inside the string, so nothing is stripped.
    expect(stripComments(src)).toBe(src);
  });

  it("leaves a chained division `a/b/c` intact (not treated as a regex)", () => {
    const src = `const x = a/b/c;`;
    expect(stripComments(src)).toBe(src);
  });

  it("treats `return /re/` as a regex, not division", () => {
    const src = `function f() { return /a\\/b/.test(s); }`;
    expect(stripComments(src)).toBe(src);
  });

  it("recognizes a regex after the `return` keyword so a trailing comment IS stripped", () => {
    // Distinguishes regex-parse from division-parse: if `return /'/` were misread
    // as division, the `'` would open a string that swallows the `// c` and leaves
    // it un-stripped. The keyword heuristic must see `return` despite the space.
    const stripped = stripComments(`function f() { return /'/ // c\n  keep\n}`);
    expect(stripped).not.toContain("// c");
    expect(stripped).toContain("keep");
  });

  it("keeps division as division across a block comment (heuristic ignores comments)", () => {
    const stripped = stripComments(`const x = a /* z */ / b; // gone`);
    expect(stripped).toContain("/ b");
    expect(stripped).not.toContain("gone");
  });

  it("keeps a regex as a regex across a block comment after `=`", () => {
    // `= /* z */ /a\/\/b/` — the comment must not reset the heuristic, so the
    // regex (with its escaped `//`) survives while only the comment is dropped.
    const stripped = stripComments(`const re = /* z */ /a\\/\\/b/;`);
    expect(stripped).toContain(`/a\\/\\/b/`);
    expect(stripped).not.toContain("z");
  });

  it("recognizes a regex after the `throw` keyword so a trailing comment IS stripped", () => {
    const stripped = stripComments(`function f() { throw /'/ // c\n}`);
    expect(stripped).not.toContain("// c");
  });

  it("treats `/` after a Unicode identifier as division (so the comment is stripped)", () => {
    // ASCII-only `\w` would misclassify a non-ASCII identifier and treat the `/`
    // as a regex, swallowing the trailing comment. The punctuator-exclusion test
    // keeps it as division.
    const stripped = stripComments(`const 名 = a; 名 / 2; // gone`);
    expect(stripped).toContain("名 / 2");
    expect(stripped).not.toContain("gone");
  });
});

describe("extractImportSpecifiers", () => {
  it("extracts a real import placed AFTER a string-with-`//` on the same line", () => {
    // The false-negative case from issue #414: the old regex over-stripped the
    // line-comment-looking `//` inside the string and dropped the trailing import.
    const code = `const note = "see // here"; import { x } from "@linchkit/core/src/foo";`;
    expect(extractImportSpecifiers(code)).toContain("@linchkit/core/src/foo");
  });

  it("does NOT extract a commented-out import", () => {
    const code = `// import x from "@linchkit/core/src/foo";\nimport { y } from "@linchkit/core";`;
    const specs = extractImportSpecifiers(code);
    expect(specs).toContain("@linchkit/core");
    expect(specs).not.toContain("@linchkit/core/src/foo");
  });

  it("does NOT extract a path that only appears in a JSDoc block comment", () => {
    const code = [
      `/**`,
      ` * See @linchkit/core/src/engine/foo for details.`,
      ` */`,
      `import { y } from "@linchkit/core";`,
    ].join("\n");
    const specs = extractImportSpecifiers(code);
    expect(specs).toEqual(["@linchkit/core"]);
  });

  it("extracts a multi-line import specifier after stripping", () => {
    const code = ["import {", "  X,", "  Y,", '} from "@linchkit/core/src/bar";'].join("\n");
    expect(extractImportSpecifiers(code)).toContain("@linchkit/core/src/bar");
  });

  it("extracts an import even when a block comment splits the statement", () => {
    const code = `import /* inline */ { X } from "@linchkit/core/src/baz";`;
    expect(extractImportSpecifiers(code)).toContain("@linchkit/core/src/baz");
  });

  it("does NOT raise a false positive from a core path mentioned in a comment after a regex", () => {
    // A comment trailing a regex-returning line must still be stripped — otherwise
    // a core-internal path named in prose would leak in as a phantom import.
    const code = `function f() { return /\\s/ // see @linchkit/core/src/foo for details\n}`;
    expect(extractImportSpecifiers(code)).toEqual([]);
  });
});
