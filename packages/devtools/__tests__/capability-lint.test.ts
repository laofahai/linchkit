import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintCapability } from "../src/methodology/capability-lint";

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
        linchkit: { type: "adapter", category: "integration", minCoreVersion: "^0.1.0" },
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
});
