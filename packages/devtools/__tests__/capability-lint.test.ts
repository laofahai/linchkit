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
