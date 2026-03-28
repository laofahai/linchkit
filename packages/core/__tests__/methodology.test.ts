import { describe, expect, it } from "bun:test";
import {
  type ActionInfo,
  type CommitInfo,
  checkActionDefinitions,
  checkCommitMessages,
  checkFileNaming,
  checkImportPatterns,
  checkSchemaDefinitions,
  type DirectoryEntry,
  type FileContent,
  type SchemaInfo,
  validateCapabilityStructure,
  validateExportPatterns,
  validateNamingConventions,
  validateProjectStructure,
} from "@linchkit/devtools/methodology";

// ── validateNamingConventions ───────────────────────────

describe("validateNamingConventions", () => {
  it("passes for well-named files and symbols", () => {
    const files: FileContent[] = [
      {
        path: "src/my-module.ts",
        content: [
          "export function createFoo() { return 1; }",
          "export class FooBar {}",
          "export interface MyType {}",
          "export const MAX_RETRY = 3;",
        ].join("\n"),
      },
    ];

    const report = validateNamingConventions(files);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });

  it("warns on non-kebab-case file names", () => {
    const files: FileContent[] = [{ path: "src/myModule.ts", content: "" }];

    const report = validateNamingConventions(files);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(report.issues[0].rule).toBe("file-naming");
  });

  it("skips index files", () => {
    const files: FileContent[] = [{ path: "src/index.ts", content: "" }];

    const report = validateNamingConventions(files);
    expect(report.passed).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("errors on non-PascalCase class names", () => {
    const files: FileContent[] = [{ path: "src/bad.ts", content: "export class my_class {}" }];

    const report = validateNamingConventions(files);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "class-naming")).toBe(true);
  });

  it("errors on non-PascalCase interface names", () => {
    const files: FileContent[] = [
      { path: "src/types.ts", content: "export interface bad_type {}" },
    ];

    const report = validateNamingConventions(files);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "type-naming")).toBe(true);
  });

  it("warns on non-camelCase function names", () => {
    const files: FileContent[] = [{ path: "src/util.ts", content: "export function BadFunc() {}" }];

    const report = validateNamingConventions(files);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((i) => i.rule === "function-naming")).toBe(true);
  });
});

// ── checkImportPatterns ─────────────────────────────────

describe("checkImportPatterns", () => {
  it("passes for correctly ordered imports", () => {
    const files: FileContent[] = [
      {
        path: "src/foo.ts",
        content: [
          'import { z } from "zod";',
          'import { Schema } from "@linchkit/core";',
          'import { helper } from "./helper";',
        ].join("\n"),
      },
    ];

    const report = checkImportPatterns(files);
    expect(report.passed).toBe(true);
    expect(report.issues.filter((i) => i.rule === "import-order")).toHaveLength(0);
  });

  it("warns on out-of-order imports", () => {
    const files: FileContent[] = [
      {
        path: "src/foo.ts",
        content: ['import { helper } from "./helper";', 'import { z } from "zod";'].join("\n"),
      },
    ];

    const report = checkImportPatterns(files);
    expect(report.issues.some((i) => i.rule === "import-order")).toBe(true);
  });

  it("detects circular dependencies", () => {
    const files: FileContent[] = [
      {
        path: "src/a.ts",
        content: 'import { b } from "./b";',
      },
      {
        path: "src/b.ts",
        content: 'import { a } from "./a";',
      },
    ];

    const report = checkImportPatterns(files);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "circular-dependency")).toBe(true);
  });
});

// ── validateExportPatterns ──────────────────────────────

describe("validateExportPatterns", () => {
  it("errors when browser-safe entry imports server-only module", () => {
    const files: FileContent[] = [
      {
        path: "src/index.ts",
        content: 'export { db } from "drizzle-orm";',
      },
    ];

    const report = validateExportPatterns(
      [{ entryPoint: "src/index.ts", browserSafe: true }],
      files,
    );

    expect(report.passed).toBe(false);
    expect(report.issues[0].rule).toBe("export-boundary");
  });

  it("passes for server-only entry point importing server modules", () => {
    const files: FileContent[] = [
      {
        path: "src/server.ts",
        content: 'export { db } from "drizzle-orm";',
      },
    ];

    const report = validateExportPatterns(
      [{ entryPoint: "src/server.ts", browserSafe: false }],
      files,
    );

    expect(report.passed).toBe(true);
  });

  it("passes for browser-safe entry with no server imports", () => {
    const files: FileContent[] = [
      {
        path: "src/index.ts",
        content: 'export { VERSION } from "./version";',
      },
    ];

    const report = validateExportPatterns(
      [{ entryPoint: "src/index.ts", browserSafe: true }],
      files,
    );

    expect(report.passed).toBe(true);
    expect(report.issues).toHaveLength(0);
  });
});

// ── validateProjectStructure ────────────────────────────

describe("validateProjectStructure", () => {
  it("passes when all required dirs exist", () => {
    const entries: DirectoryEntry[] = [
      { path: "src", isDirectory: true },
      { path: "src/types", isDirectory: true },
      { path: "__tests__", isDirectory: true },
    ];

    const report = validateProjectStructure("/pkg", entries);
    expect(report.passed).toBe(true);
  });

  it("errors when required src dir is missing", () => {
    const entries: DirectoryEntry[] = [{ path: "__tests__", isDirectory: true }];

    const report = validateProjectStructure("/pkg", entries);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.message.includes("src"))).toBe(true);
  });

  it("reports info for missing recommended dirs", () => {
    const entries: DirectoryEntry[] = [{ path: "src", isDirectory: true }];

    const report = validateProjectStructure("/pkg", entries);
    // src/types and __tests__ are optional — should be info, not error
    expect(report.passed).toBe(true);
    expect(report.issues.some((i) => i.severity === "info")).toBe(true);
  });
});

// ── validateCapabilityStructure ─────────────────────────

describe("validateCapabilityStructure", () => {
  it("passes for a well-structured capability", () => {
    const entries: DirectoryEntry[] = [
      { path: "src", isDirectory: true },
      { path: "src/index.ts", isDirectory: false },
      { path: "src/schemas", isDirectory: true },
      { path: "package.json", isDirectory: false },
    ];

    const report = validateCapabilityStructure("capabilities/cap-purchase-demo", entries);
    expect(report.passed).toBe(true);
  });

  it("warns when capability directory lacks cap- prefix", () => {
    const entries: DirectoryEntry[] = [
      { path: "src", isDirectory: true },
      { path: "package.json", isDirectory: false },
    ];

    const report = validateCapabilityStructure("capabilities/purchase-demo", entries);
    expect(report.issues.some((i) => i.rule === "capability-naming")).toBe(true);
  });

  it("errors when package.json is missing", () => {
    const entries: DirectoryEntry[] = [{ path: "src", isDirectory: true }];

    const report = validateCapabilityStructure("capabilities/cap-foo", entries);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.message.includes("package.json"))).toBe(true);
  });
});

// ── checkFileNaming ─────────────────────────────────────

describe("checkFileNaming", () => {
  it("passes for kebab-case files", () => {
    const report = checkFileNaming("kebab-case", [
      "src/my-module.ts",
      "src/index.ts",
      "src/schema-registry.ts",
    ]);
    expect(report.passed).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("warns on camelCase file names", () => {
    const report = checkFileNaming("kebab-case", ["src/myModule.ts"]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].rule).toBe("file-naming");
  });

  it("skips dotfiles and underscored files", () => {
    const report = checkFileNaming("kebab-case", [".env", "_internal.ts"]);
    expect(report.issues).toHaveLength(0);
  });
});

// ── checkCommitMessages ─────────────────────────────────

describe("checkCommitMessages", () => {
  it("passes for valid Conventional Commits", () => {
    const commits: CommitInfo[] = [
      { message: "feat: add purchase schema" },
      { message: "fix(core): resolve circular import" },
      { message: "docs: update README" },
      { message: "refactor(cli): simplify dev command" },
      { message: "test(server): add GraphQL tests" },
    ];

    const report = checkCommitMessages(commits);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
  });

  it("errors on non-conventional commit messages", () => {
    const commits: CommitInfo[] = [{ message: "Updated the thing" }, { message: "WIP" }];

    const report = checkCommitMessages(commits);
    expect(report.passed).toBe(false);
    expect(report.summary.errors).toBe(2);
  });

  it("errors on empty commit messages", () => {
    const report = checkCommitMessages([{ message: "" }]);
    expect(report.passed).toBe(false);
    expect(report.issues[0].rule).toBe("commit-message");
  });

  it("warns on overly long commit messages", () => {
    const longMsg = `feat: ${"a".repeat(100)}`;
    const report = checkCommitMessages([{ message: longMsg }]);
    expect(report.issues.some((i) => i.rule === "commit-message-length")).toBe(true);
  });

  it("accepts breaking change indicator", () => {
    const report = checkCommitMessages([
      { message: "feat!: remove deprecated API" },
      { message: "fix(core)!: change return type" },
    ]);
    expect(report.passed).toBe(true);
  });
});

// ── checkSchemaDefinitions ──────────────────────────────

describe("checkSchemaDefinitions", () => {
  it("passes for valid schema definitions", () => {
    const schemas: SchemaInfo[] = [
      {
        name: "purchase_request",
        fields: [
          { name: "title", type: "string" },
          { name: "amount", type: "number" },
          { name: "is_urgent", type: "boolean" },
          { name: "created_at", type: "datetime" },
        ],
      },
    ];

    const report = checkSchemaDefinitions(schemas);
    expect(report.passed).toBe(true);
    expect(report.summary.warnings).toBe(0);
  });

  it("errors on non-snake_case schema name", () => {
    const report = checkSchemaDefinitions([{ name: "PurchaseRequest" }]);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "schema-naming")).toBe(true);
  });

  it("errors on reserved word schema name", () => {
    const report = checkSchemaDefinitions([{ name: "order" }]);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "schema-reserved")).toBe(true);
  });

  it("warns on plural schema name", () => {
    const report = checkSchemaDefinitions([{ name: "purchase_requests" }]);
    expect(report.issues.some((i) => i.rule === "schema-singular")).toBe(true);
  });

  it("does not warn on _status suffix", () => {
    const report = checkSchemaDefinitions([{ name: "approval_status" }]);
    expect(report.issues.filter((i) => i.rule === "schema-singular")).toHaveLength(0);
  });

  it("warns on boolean fields without is_/has_ prefix", () => {
    const schemas: SchemaInfo[] = [
      {
        name: "item",
        fields: [{ name: "active", type: "boolean" }],
      },
    ];

    const report = checkSchemaDefinitions(schemas);
    expect(report.issues.some((i) => i.rule === "boolean-prefix")).toBe(true);
  });

  it("warns on datetime fields without _at suffix", () => {
    const schemas: SchemaInfo[] = [
      {
        name: "item",
        fields: [{ name: "approved", type: "datetime" }],
      },
    ];

    const report = checkSchemaDefinitions(schemas);
    expect(report.issues.some((i) => i.rule === "datetime-suffix")).toBe(true);
  });
});

// ── checkActionDefinitions ──────────────────────────────

describe("checkActionDefinitions", () => {
  it("passes for valid action definitions", () => {
    const actions: ActionInfo[] = [
      { name: "submit_request", schema: "purchase_request" },
      { name: "approve_request", schema: "purchase_request" },
      { name: "reject_request", schema: "purchase_request" },
    ];

    const report = checkActionDefinitions(actions);
    expect(report.passed).toBe(true);
    expect(report.summary.warnings).toBe(0);
  });

  it("errors on non-snake_case action name", () => {
    const report = checkActionDefinitions([{ name: "submitRequest", schema: "purchase_request" }]);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "action-naming")).toBe(true);
  });

  it("warns on single-word action name (no verb_noun)", () => {
    const report = checkActionDefinitions([{ name: "submit", schema: "purchase_request" }]);
    expect(report.issues.some((i) => i.rule === "action-verb-noun")).toBe(true);
  });

  it("warns on generic CRUD verbs", () => {
    const report = checkActionDefinitions([
      { name: "create_request", schema: "purchase_request" },
      { name: "update_request", schema: "purchase_request" },
      { name: "delete_request", schema: "purchase_request" },
    ]);
    expect(report.issues.filter((i) => i.rule === "action-semantic-verb")).toHaveLength(3);
  });

  it("errors on non-snake_case schema reference", () => {
    const report = checkActionDefinitions([{ name: "submit_request", schema: "PurchaseRequest" }]);
    expect(report.passed).toBe(false);
    expect(report.issues.some((i) => i.rule === "action-schema-ref")).toBe(true);
  });
});
