import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  type ConventionalCommit,
  generateChangelog,
  generateSpecReport,
  generateVersionedChangelog,
  parseConventionalCommit,
  SpecTracker,
  validateActionDoc,
  validateCapabilityDoc,
  validateSchemaDoc,
} from "@linchkit/devtools/governance";
import type { ActionDefinition } from "../src/types/action";
import type { CapabilityDefinition } from "../src/types/capability";
import type { SchemaDefinition } from "../src/types/schema";

// ── DocValidator: Schema ─────────────────────────────────

describe("validateSchemaDoc", () => {
  it("returns 100% coverage for fully documented schema", () => {
    const schema: SchemaDefinition = {
      name: "product",
      label: "Product",
      description: "A product in the catalog",
      fields: {
        name: { type: "string", label: "Name", description: "Product name" },
        price: { type: "number", label: "Price", description: "Unit price" },
      },
    };

    const result = validateSchemaDoc(schema);
    expect(result.coverage).toBe(100);
    expect(result.issues).toHaveLength(0);
    expect(result.type).toBe("schema");
    expect(result.name).toBe("product");
  });

  it("detects missing schema description as error", () => {
    const schema: SchemaDefinition = {
      name: "bare",
      label: "Bare",
      fields: {
        id: { type: "string", label: "ID", description: "Unique identifier" },
      },
    };

    const result = validateSchemaDoc(schema);
    expect(result.coverage).toBeLessThan(100);
    const descIssue = result.issues.find((i) => i.path === "description");
    expect(descIssue).toBeDefined();
    expect(descIssue?.severity).toBe("error");
  });

  it("detects missing field description as warning", () => {
    const schema: SchemaDefinition = {
      name: "test",
      label: "Test",
      description: "Test schema",
      fields: {
        value: { type: "number" },
      },
    };

    const result = validateSchemaDoc(schema);
    const fieldIssue = result.issues.find((i) => i.path === "fields.value.description");
    expect(fieldIssue).toBeDefined();
    expect(fieldIssue?.severity).toBe("warning");
  });

  it("detects missing enum option labels as info", () => {
    const schema: SchemaDefinition = {
      name: "order",
      label: "Order",
      description: "Purchase order",
      fields: {
        status: {
          type: "enum",
          label: "Status",
          description: "Order status",
          options: [{ value: "draft" }, { value: "confirmed", label: "Confirmed" }],
        },
      },
    };

    const result = validateSchemaDoc(schema);
    const optionIssue = result.issues.find((i) => i.path === "fields.status.options.draft");
    expect(optionIssue).toBeDefined();
    expect(optionIssue?.severity).toBe("info");
  });

  it("handles schema with no fields", () => {
    const schema: SchemaDefinition = {
      name: "empty",
      label: "Empty",
      description: "Empty schema",
      fields: {},
    };

    const result = validateSchemaDoc(schema);
    expect(result.coverage).toBe(100);
    expect(result.totalItems).toBe(2); // description + label
  });
});

// ── DocValidator: Action ─────────────────────────────────

describe("validateActionDoc", () => {
  it("returns 100% for fully documented action", () => {
    const action: ActionDefinition = {
      name: "create_order",
      schema: "order",
      label: "Create Order",
      description: "Creates a new purchase order",
      input: {
        customer_id: { type: "string", description: "Customer identifier" },
      },
      output: {
        order_id: { type: "string", description: "Created order ID" },
      },
    };

    const result = validateActionDoc(action);
    expect(result.coverage).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing action description as error", () => {
    const action: ActionDefinition = {
      name: "bare_action",
      schema: "test",
      label: "Bare",
    };

    const result = validateActionDoc(action);
    const issue = result.issues.find((i) => i.path === "description");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });

  it("detects missing input param description as warning", () => {
    const action: ActionDefinition = {
      name: "submit",
      schema: "order",
      label: "Submit",
      description: "Submit order",
      input: {
        amount: { type: "number" },
      },
    };

    const result = validateActionDoc(action);
    const issue = result.issues.find((i) => i.path === "input.amount.description");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("handles action with no input/output", () => {
    const action: ActionDefinition = {
      name: "noop",
      schema: "test",
      label: "No-op",
      description: "Does nothing",
    };

    const result = validateActionDoc(action);
    expect(result.coverage).toBe(100);
    expect(result.totalItems).toBe(1);
  });
});

// ── DocValidator: Capability ─────────────────────────────

describe("validateCapabilityDoc", () => {
  it("returns 100% for fully documented capability", () => {
    const cap: CapabilityDefinition = {
      name: "cap-purchase",
      label: "Purchase Management",
      description: "Handles purchase requests and approvals",
      type: "standard",
      category: "business",
      version: "1.0.0",
      schemas: [{ name: "purchase_request", description: "A purchase request", fields: {} }],
      actions: [
        {
          name: "submit_pr",
          schema: "purchase_request",
          label: "Submit",
          description: "Submit PR",
        },
      ],
    };

    const result = validateCapabilityDoc(cap);
    expect(result.coverage).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing capability description", () => {
    const cap: CapabilityDefinition = {
      name: "bare-cap",
      label: "Bare",
      type: "standard",
      category: "business",
      version: "0.1.0",
    };

    const result = validateCapabilityDoc(cap);
    expect(result.coverage).toBe(0);
    const issue = result.issues.find((i) => i.path === "description");
    expect(issue?.severity).toBe("error");
  });

  it("detects undocumented schemas and actions in capability", () => {
    const cap: CapabilityDefinition = {
      name: "partial-cap",
      label: "Partial",
      description: "Has some docs",
      type: "standard",
      category: "business",
      version: "0.1.0",
      schemas: [{ name: "no_desc", fields: {} }],
      actions: [{ name: "no_desc_action", schema: "no_desc", label: "Act" }],
    };

    const result = validateCapabilityDoc(cap);
    expect(result.coverage).toBeLessThan(100);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

// ── ChangelogGenerator ───────────────────────────────────

describe("parseConventionalCommit", () => {
  it("parses a feat commit", () => {
    const result = parseConventionalCommit("feat(schema): add inheritance support", {
      hash: "abc1234567890",
      date: new Date("2026-01-15"),
      author: "dev",
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe("feat");
    expect(result?.scope).toBe("schema");
    expect(result?.subject).toBe("add inheritance support");
    expect(result?.breaking).toBe(false);
    expect(result?.shortHash).toBe("abc1234");
  });

  it("parses a breaking change with ! suffix", () => {
    const result = parseConventionalCommit("refactor!: rewrite action engine API", {
      hash: "def4567890123",
      date: new Date("2026-02-01"),
      author: "dev",
    });

    expect(result).not.toBeNull();
    expect(result?.breaking).toBe(true);
    expect(result?.type).toBe("refactor");
  });

  it("detects BREAKING CHANGE in body", () => {
    const result = parseConventionalCommit("feat: new schema format", {
      hash: "1234567890abc",
      date: new Date("2026-02-10"),
      author: "dev",
      body: "BREAKING CHANGE: field format changed",
    });

    expect(result?.breaking).toBe(true);
  });

  it("returns null for non-conventional message", () => {
    const result = parseConventionalCommit("just a random commit", {
      hash: "aaa1111222233",
      date: new Date(),
      author: "dev",
    });

    expect(result).toBeNull();
  });

  it("parses commit without scope", () => {
    const result = parseConventionalCommit("fix: prevent null pointer", {
      hash: "bbb2222333344",
      date: new Date(),
      author: "dev",
    });

    expect(result?.scope).toBeUndefined();
    expect(result?.type).toBe("fix");
  });
});

describe("generateChangelog", () => {
  const commits: ConventionalCommit[] = [
    {
      hash: "aaaa",
      shortHash: "aaaa",
      type: "feat",
      scope: "core",
      breaking: false,
      subject: "add governance module",
      date: new Date("2026-03-25"),
      author: "dev",
    },
    {
      hash: "bbbb",
      shortHash: "bbbb",
      type: "fix",
      breaking: false,
      subject: "fix validation edge case",
      date: new Date("2026-03-24"),
      author: "dev",
    },
    {
      hash: "cccc",
      shortHash: "cccc",
      type: "feat",
      scope: "ui",
      breaking: true,
      subject: "redesign form layout",
      date: new Date("2026-03-23"),
      author: "dev",
    },
    {
      hash: "dddd",
      shortHash: "dddd",
      type: "docs",
      breaking: false,
      subject: "update spec 37",
      date: new Date("2026-03-22"),
      author: "dev",
    },
  ];

  it("generates markdown with version header", () => {
    const md = generateChangelog(commits, {
      version: "0.2.0",
      date: new Date("2026-03-25"),
    });

    expect(md).toContain("## 0.2.0 (2026-03-25)");
    expect(md).toContain("### Features");
    expect(md).toContain("### Bug Fixes");
    expect(md).toContain("### Documentation");
    expect(md).toContain("**core:** add governance module");
    expect(md).toContain("fix validation edge case");
  });

  it("generates Unreleased header when no version given", () => {
    const md = generateChangelog(commits);
    expect(md).toContain("## Unreleased");
  });

  it("includes breaking changes section", () => {
    const md = generateChangelog(commits);
    expect(md).toContain("### BREAKING CHANGES");
    expect(md).toContain("redesign form layout");
  });

  it("filters by includeTypes", () => {
    const md = generateChangelog(commits, { includeTypes: ["feat"] });
    expect(md).toContain("### Features");
    expect(md).not.toContain("### Bug Fixes");
  });

  it("omits hashes when includeHashes=false", () => {
    const md = generateChangelog(commits, { includeHashes: false });
    expect(md).not.toContain("(aaaa)");
  });

  it("returns empty string for no commits", () => {
    const md = generateChangelog([]);
    expect(md).toBe("");
  });
});

describe("generateVersionedChangelog", () => {
  it("generates multi-version changelog", () => {
    const versions = [
      {
        version: "0.2.0",
        date: new Date("2026-03-25"),
        commits: [
          {
            hash: "a1",
            shortHash: "a1",
            type: "feat",
            breaking: false,
            subject: "new feature",
            date: new Date("2026-03-25"),
            author: "dev",
          },
        ] as ConventionalCommit[],
      },
      {
        version: "0.1.0",
        date: new Date("2026-03-01"),
        commits: [
          {
            hash: "b1",
            shortHash: "b1",
            type: "fix",
            breaking: false,
            subject: "initial fix",
            date: new Date("2026-03-01"),
            author: "dev",
          },
        ] as ConventionalCommit[],
      },
    ];

    const md = generateVersionedChangelog(versions);
    expect(md).toContain("# Changelog");
    expect(md).toContain("## 0.2.0");
    expect(md).toContain("## 0.1.0");
  });
});

// ── SpecTracker ──────────────────────────────────────────

describe("SpecTracker", () => {
  let tracker: SpecTracker;

  beforeEach(() => {
    tracker = new SpecTracker();
  });

  it("registers and retrieves specs", () => {
    tracker.register({
      name: "Schema",
      specFile: "docs/specs/03_schema.md",
      status: "done",
    });

    const status = tracker.getStatus("docs/specs/03_schema.md");
    expect(status).toBeDefined();
    expect(status?.name).toBe("Schema");
    expect(status?.status).toBe("done");
  });

  it("updates spec status", () => {
    tracker.register({
      name: "Flow",
      specFile: "docs/specs/10_flow.md",
      status: "planned",
    });

    const updated = tracker.updateStatus("docs/specs/10_flow.md", "in-progress", "WIP");
    expect(updated).toBe(true);

    const status = tracker.getStatus("docs/specs/10_flow.md");
    expect(status?.status).toBe("in-progress");
    expect(status?.notes).toBe("WIP");
  });

  it("returns false for updating non-existent spec", () => {
    const updated = tracker.updateStatus("nonexistent.md", "done");
    expect(updated).toBe(false);
  });

  it("generates progress report", () => {
    tracker.register({ name: "Schema", specFile: "03_schema.md", status: "done" });
    tracker.register({ name: "Action", specFile: "04_action.md", status: "done" });
    tracker.register({ name: "Flow", specFile: "10_flow.md", status: "in-progress" });
    tracker.register({ name: "Legacy", specFile: "00_legacy.md", status: "deprecated" });

    const report = tracker.generateReport();
    expect(report.total).toBe(4);
    expect(report.counts.done).toBe(2);
    expect(report.counts["in-progress"]).toBe(1);
    expect(report.counts.deprecated).toBe(1);
    // Completion: 2 done / 3 non-deprecated = 67%
    expect(report.completionPercent).toBe(67);
  });

  it("reports 100% when all non-deprecated specs are done", () => {
    tracker.register({ name: "A", specFile: "a.md", status: "done" });
    tracker.register({ name: "B", specFile: "b.md", status: "deprecated" });

    const report = tracker.generateReport();
    expect(report.completionPercent).toBe(100);
  });

  it("reports 100% when no specs exist", () => {
    const report = tracker.generateReport();
    expect(report.completionPercent).toBe(100);
    expect(report.total).toBe(0);
  });

  it("scans actual docs/specs directory", async () => {
    const specsDir = join(import.meta.dir, "../../../docs/specs");
    const count = await tracker.scanDirectory(specsDir);
    // Project has spec files; at least some should be found
    expect(count).toBeGreaterThan(0);
    expect(tracker.getAllSpecs().length).toBeGreaterThan(0);
  });

  it("handles non-existent directory gracefully", async () => {
    const count = await tracker.scanDirectory("/nonexistent/path");
    expect(count).toBe(0);
  });
});

describe("generateSpecReport", () => {
  it("generates valid markdown report", () => {
    const tracker = new SpecTracker();
    tracker.register({ name: "Schema", specFile: "03_schema.md", status: "done" });
    tracker.register({ name: "Action", specFile: "04_action.md", status: "in-progress" });
    tracker.register({ name: "Old", specFile: "00_old.md", status: "deprecated" });

    const report = tracker.generateReport();
    const md = generateSpecReport(report);

    expect(md).toContain("# Specification Progress Report");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Details");
    expect(md).toContain("Schema");
    expect(md).toContain("[x]");
    expect(md).toContain("[-]");
    expect(md).toContain("[~]");
    expect(md).toContain("done");
    expect(md).toContain("in-progress");
    expect(md).toContain("deprecated");
  });
});
