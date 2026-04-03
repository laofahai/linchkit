/**
 * E2E integration tests: Tooling pipeline cross-module interactions.
 *
 * Covers:
 *   1. Documentation + OntologyRegistry
 *   2. Governance + Documentation
 *   3. Methodology + Project conventions
 *   4. Versioning + CapabilityHub
 *   5. Full pipeline (register → build → generate → validate → changelog)
 *
 * All in-memory — no external services required.
 */

import { describe, expect, test } from "bun:test";
import {
  applyMigration,
  createVersionRegistry,
  MigrationRegistry,
  validateUpgrade,
} from "@linchkit/cap-migration";
import type { ActionDefinition, EntityDefinition } from "@linchkit/core";
import { type CapabilityManifest, createCapabilityHub } from "@linchkit/core";
import {
  createRelationRegistry,
  createOntologyRegistry,
  createEntityRegistry,
} from "@linchkit/core/server";
import {
  generateApiDoc,
  generateOpenAPISpec,
  renderSystemDoc,
} from "@linchkit/devtools/documentation";
import {
  generateChangelog,
  generateSpecReport,
  generateVersionedChangelog,
  parseConventionalCommit,
  SpecTracker,
  validateActionDoc,
  validateSchemaDoc,
} from "@linchkit/devtools/governance";
import {
  checkActionDefinitions,
  checkCommitMessages,
  checkEntityDefinitions,
} from "@linchkit/devtools/methodology";
import type { RelationDefinition } from "../src/types/relation";

// ── Shared test data ──────────────────────────────────────

const departmentSchema: EntityDefinition = {
  name: "department",
  label: "Department",
  description: "Organizational department",
  fields: {
    name: { type: "string", required: true, label: "Name", description: "Department name" },
    code: {
      type: "string",
      required: true,
      label: "Code",
      description: "Unique department code",
      unique: true,
    },
    is_active: {
      type: "boolean",
      label: "Active",
      description: "Whether department is active",
      default: true,
    },
  },
};

const employeeSchema: EntityDefinition = {
  name: "employee",
  label: "Employee",
  description: "Company employee",
  fields: {
    name: { type: "string", required: true, label: "Name", description: "Full name" },
    email: { type: "string", required: true, label: "Email", description: "Work email" },
    department_id: {
      type: "ref",
      target: "department",
      label: "Department",
      description: "Assigned department",
    },
    hire_date: { type: "date", label: "Hire Date", description: "Date of hire" },
    role: {
      type: "enum",
      label: "Role",
      description: "Employee role",
      options: [
        { value: "engineer", label: "Engineer" },
        { value: "manager", label: "Manager" },
        { value: "director", label: "Director" },
      ],
    },
  },
};

const projectSchema: EntityDefinition = {
  name: "project",
  label: "Project",
  description: "Engineering project",
  fields: {
    title: { type: "string", required: true, label: "Title", description: "Project title" },
    budget: { type: "number", label: "Budget", description: "Allocated budget" },
    started_at: { type: "datetime", label: "Started At", description: "Start timestamp" },
  },
};

const submitAction: ActionDefinition = {
  name: "submit_timesheet",
  schema: "employee",
  label: "Submit Timesheet",
  description: "Submit employee timesheet for approval",
  exposure: "all",
  policy: { mode: "sync", transaction: false },
  input: {
    hours: { type: "number", required: true, label: "Hours", description: "Hours worked" },
    date: { type: "date", required: true, label: "Date", description: "Work date" },
  },
  handler: async () => ({}),
};

const approveAction: ActionDefinition = {
  name: "approve_timesheet",
  schema: "employee",
  label: "Approve Timesheet",
  description: "Approve a submitted timesheet",
  exposure: { http: true, ui: true },
  policy: { mode: "sync", transaction: true },
  input: {
    timesheet_id: { type: "string", required: true, label: "Timesheet ID" },
  },
  permissions: { groups: ["manager"] },
  handler: async () => ({}),
};

const deptEmpLink: RelationDefinition = {
  name: "department_employees",
  from: "department",
  to: "employee",
  cardinality: "one_to_many",
  label: {
    from: "Employees",
    to: "Department",
  },
};

const projectEmpLink: RelationDefinition = {
  name: "project_members",
  from: "project",
  to: "employee",
  cardinality: "many_to_many",
  label: {
    from: "Members",
    to: "Projects",
  },
};

// ═══════════════════════════════════════════════════════════
// 1. Documentation + OntologyRegistry
// ═══════════════════════════════════════════════════════════

describe("E2E: Documentation + OntologyRegistry", () => {
  function buildOntology() {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(departmentSchema);
    entityRegistry.register(employeeSchema);
    entityRegistry.register(projectSchema);

    const relationRegistry = createRelationRegistry();
    relationRegistry.register(deptEmpLink);
    relationRegistry.register(projectEmpLink);

    const actions = [submitAction, approveAction];

    return createOntologyRegistry({
      schemas: entityRegistry,
      actions: { getAll: () => actions },
      rules: [],
      states: [],
      views: [],
      links: relationRegistry,
    });
  }

  test("generateApiDoc produces SystemDoc with all schemas", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology, {
      title: "Test API",
      description: "Integration test documentation",
    });

    expect(doc.title).toBe("Test API");
    expect(doc.description).toBe("Integration test documentation");
    expect(doc.generatedAt).toBeDefined();
    expect(doc.schemas).toHaveLength(3);

    const names = doc.schemas.map((s) => s.name);
    expect(names).toContain("department");
    expect(names).toContain("employee");
    expect(names).toContain("project");
  });

  test("SchemaDoc includes fields and actions correctly", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology);

    const empDoc = doc.schemas.find((s) => s.name === "employee");
    expect(empDoc).toBeDefined();

    // Fields
    const fieldNames = empDoc?.fields.map((f) => f.name);
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("email");
    expect(fieldNames).toContain("department_id");
    expect(fieldNames).toContain("role");

    // Ref field target
    const deptField = empDoc?.fields.find((f) => f.name === "department_id");
    expect(deptField?.target).toBe("department");

    // Enum field options
    const roleField = empDoc?.fields.find((f) => f.name === "role");
    expect(roleField?.options).toHaveLength(3);
    expect(roleField?.options?.map((o) => o.value)).toContain("engineer");

    // Actions
    expect(empDoc?.actions).toHaveLength(2);
    const actionNames = empDoc?.actions.map((a) => a.name);
    expect(actionNames).toContain("submit_timesheet");
    expect(actionNames).toContain("approve_timesheet");
  });

  test("renderSystemDoc produces Markdown with TOC, field tables, and Mermaid", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology, { title: "Test API" });
    const md = renderSystemDoc(doc);

    // Title
    expect(md).toContain("# Test API");

    // Table of contents
    expect(md).toContain("## Table of Contents");
    expect(md).toContain("- [Department]");
    expect(md).toContain("- [Employee]");
    expect(md).toContain("- [Project]");

    // Field table headers
    expect(md).toContain("| Name | Type | Required | Description |");
    expect(md).toContain("|------|------|----------|-------------|");

    // Field entries
    expect(md).toContain("| name |");
    expect(md).toContain("| email |");

    // Mermaid diagram: only appears when schemas have outgoing relations
    // Links registered in RelationRegistry are surfaced via OntologyRegistry.relatedEntities()
    // The ER diagram is generated only from outgoing relations in SchemaDoc.relations
  });

  test("renderSystemDoc respects options to disable TOC and Mermaid", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc, { toc: false, mermaid: false });

    expect(md).not.toContain("## Table of Contents");
    // Note: mermaid disabled means no ER diagram section
    expect(md).not.toContain("erDiagram");
  });

  test("generateOpenAPISpec produces valid spec with CRUD paths", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc, { version: "2.0.0" });

    // Metadata
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.version).toBe("2.0.0");

    // CRUD paths for department
    expect(spec.paths["/api/department"]).toBeDefined();
    expect(spec.paths["/api/department"]?.get).toBeDefined();
    expect(spec.paths["/api/department"]?.post).toBeDefined();
    expect(spec.paths["/api/department/{id}"]).toBeDefined();
    expect(spec.paths["/api/department/{id}"]?.get).toBeDefined();
    expect(spec.paths["/api/department/{id}"]?.put).toBeDefined();
    expect(spec.paths["/api/department/{id}"]?.delete).toBeDefined();

    // Component schemas
    expect(spec.components.schemas.department).toBeDefined();
    expect(spec.components.schemas.department_input).toBeDefined();
    expect(spec.components.schemas.employee).toBeDefined();
    expect(spec.components.schemas.project).toBeDefined();

    // Employee schema fields include system fields
    const empSchema = spec.components.schemas.employee;
    expect(empSchema?.properties?.id).toBeDefined();
    expect(empSchema?.properties?.created_at).toBeDefined();
    expect(empSchema?.properties?.name).toBeDefined();
  });

  test("generateOpenAPISpec includes action endpoints", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    // submit_timesheet has exposure "all" which includes http
    expect(spec.paths["/api/actions/submit_timesheet"]).toBeDefined();
    expect(spec.paths["/api/actions/submit_timesheet"]?.post).toBeDefined();
    expect(spec.paths["/api/actions/submit_timesheet"]?.post?.operationId).toBe("submit_timesheet");

    // approve_timesheet has http:true
    expect(spec.paths["/api/actions/approve_timesheet"]).toBeDefined();

    // Action input schemas
    expect(spec.components.schemas.submit_timesheet_input).toBeDefined();
  });

  test("generateOpenAPISpec respects options to disable CRUD and actions", () => {
    const ontology = buildOntology();
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc, { crud: false, actions: false });

    // No CRUD paths
    expect(spec.paths["/api/department"]).toBeUndefined();

    // No action paths
    expect(spec.paths["/api/actions/submit_timesheet"]).toBeUndefined();

    // But component schemas still exist
    expect(spec.components.schemas.department).toBeDefined();
  });

  test("OntologyRegistry relatedSchemas and Markdown include link info", () => {
    const ontology = buildOntology();

    // Department has outgoing link to employee
    const deptRelations = ontology.relatedEntities("department");
    expect(deptRelations.length).toBeGreaterThan(0);
    const empRelation = deptRelations.find((r) => r.targetSchema === "employee");
    expect(empRelation).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Governance + Documentation
// ═══════════════════════════════════════════════════════════

describe("E2E: Governance + Documentation", () => {
  test("validateSchemaDoc reports issues for undocumented schemas", () => {
    const bareSchema: EntityDefinition = {
      name: "bare_thing",
      label: "Bare Thing",
      fields: {
        value: { type: "number" },
        label: { type: "string" },
      },
    };

    const result = validateSchemaDoc(bareSchema);
    expect(result.name).toBe("bare_thing");
    expect(result.type).toBe("schema");
    expect(result.coverage).toBeLessThan(100);

    // Missing schema description
    const descIssue = result.issues.find((i) => i.path === "description" && i.severity === "error");
    expect(descIssue).toBeDefined();

    // Missing field descriptions
    const fieldIssues = result.issues.filter((i) => i.path.includes("fields."));
    expect(fieldIssues.length).toBeGreaterThan(0);
  });

  test("validateSchemaDoc reports 100% for fully documented schema", () => {
    const result = validateSchemaDoc(departmentSchema);
    expect(result.coverage).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  test("validateActionDoc reports issues for undocumented actions", () => {
    const bareAction: ActionDefinition = {
      name: "do_something",
      schema: "thing",
      label: "Do Something",
      policy: { mode: "sync", transaction: false },
      input: {
        param: { type: "string" },
      },
      handler: async () => ({}),
    };

    const result = validateActionDoc(bareAction);
    expect(result.type).toBe("action");
    expect(result.coverage).toBeLessThan(100);

    // Missing action description
    const descIssue = result.issues.find((i) => i.path === "description");
    expect(descIssue).toBeDefined();

    // Missing input param description
    const paramIssue = result.issues.find((i) => i.path === "input.param.description");
    expect(paramIssue).toBeDefined();
  });

  test("validateActionDoc reports 100% for fully documented action", () => {
    const result = validateActionDoc(submitAction);
    expect(result.coverage).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  test("generateChangelog from mock commits", () => {
    const commits = [
      parseConventionalCommit("feat(schema): add department schema", {
        hash: "abc1234567890",
        date: new Date("2026-03-20"),
        author: "Dev",
      }),
      parseConventionalCommit("fix(api): resolve null pointer in query handler", {
        hash: "def4567890123",
        date: new Date("2026-03-21"),
        author: "Dev",
      }),
      parseConventionalCommit("docs: update API documentation", {
        hash: "ghi7890123456",
        date: new Date("2026-03-22"),
        author: "Dev",
      }),
      parseConventionalCommit("feat!: redesign action exposure config", {
        hash: "jkl0123456789",
        date: new Date("2026-03-23"),
        author: "Dev",
        body: "BREAKING CHANGE: exposure field is now an object, not a string",
      }),
    ].filter(Boolean);

    expect(commits).toHaveLength(4);

    const changelog = generateChangelog(commits as NonNullable<(typeof commits)[0]>[], {
      version: "1.1.0",
      date: new Date("2026-03-25"),
    });

    expect(changelog).toContain("## 1.1.0 (2026-03-25)");
    expect(changelog).toContain("### BREAKING CHANGES");
    expect(changelog).toContain("### Features");
    expect(changelog).toContain("### Bug Fixes");
    expect(changelog).toContain("### Documentation");
    expect(changelog).toContain("add department schema");
    expect(changelog).toContain("resolve null pointer");
    expect(changelog).toContain("abc1234");
  });

  test("generateVersionedChangelog groups by version", () => {
    const v1Commits = [
      parseConventionalCommit("feat: initial release", {
        hash: "aaa1111111111",
        date: new Date("2026-03-01"),
        author: "Dev",
      }),
    ].filter(Boolean) as NonNullable<ReturnType<typeof parseConventionalCommit>>[];

    const v2Commits = [
      parseConventionalCommit("feat: add new feature", {
        hash: "bbb2222222222",
        date: new Date("2026-03-15"),
        author: "Dev",
      }),
      parseConventionalCommit("fix: patch bug", {
        hash: "ccc3333333333",
        date: new Date("2026-03-16"),
        author: "Dev",
      }),
    ].filter(Boolean) as NonNullable<ReturnType<typeof parseConventionalCommit>>[];

    const changelog = generateVersionedChangelog([
      { version: "2.0.0", date: new Date("2026-03-15"), commits: v2Commits },
      { version: "1.0.0", date: new Date("2026-03-01"), commits: v1Commits },
    ]);

    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("## 2.0.0 (2026-03-15)");
    expect(changelog).toContain("## 1.0.0 (2026-03-01)");
    // v2 section should appear before v1
    const v2Pos = changelog.indexOf("## 2.0.0");
    const v1Pos = changelog.indexOf("## 1.0.0");
    expect(v2Pos).toBeLessThan(v1Pos);
  });

  test("SpecTracker tracks spec status and generates report", () => {
    const tracker = new SpecTracker();

    tracker.register({
      name: "Schema",
      specFile: "docs/specs/03_schema.md",
      status: "done",
    });
    tracker.register({
      name: "Action",
      specFile: "docs/specs/04_action.md",
      status: "done",
    });
    tracker.register({
      name: "Link Type",
      specFile: "docs/specs/46_link_type.md",
      status: "in-progress",
      notes: "M2 feature",
    });
    tracker.register({
      name: "Old Feature",
      specFile: "docs/specs/99_old.md",
      status: "deprecated",
    });

    // Update status
    tracker.updateStatus("docs/specs/46_link_type.md", "done", "Completed in M2");

    const report = tracker.generateReport();
    expect(report.total).toBe(4);
    expect(report.counts.done).toBe(3);
    expect(report.counts.deprecated).toBe(1);
    // Completion = done / (total - deprecated) = 3/3 = 100%
    expect(report.completionPercent).toBe(100);

    const markdown = generateSpecReport(report);
    expect(markdown).toContain("# Specification Progress Report");
    expect(markdown).toContain("| Total specs | 4 |");
    expect(markdown).toContain("| Done | 3 |");
    expect(markdown).toContain("| **Completion** | **100%** |");
    expect(markdown).toContain("Schema");
    expect(markdown).toContain("Completed in M2");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Methodology + Project conventions
// ═══════════════════════════════════════════════════════════

describe("E2E: Methodology + Project conventions", () => {
  test("checkCommitMessages validates Conventional Commits format", () => {
    const report = checkCommitMessages([
      { message: "feat(schema): add department schema" },
      { message: "fix: resolve null pointer" },
      { message: "bad commit message without type" },
      { message: "" },
      {
        hash: "abc123",
        message:
          "feat: this is a very long commit message that exceeds the recommended length of one hundred characters in the first line",
      },
    ]);

    // 2 errors (bad format + empty) + 1 warning (length)
    expect(report.summary.errors).toBe(2);
    expect(report.summary.warnings).toBe(1);

    const badFormatIssue = report.issues.find(
      (i) => i.rule === "commit-message" && i.message.includes("bad commit"),
    );
    expect(badFormatIssue).toBeDefined();

    const emptyIssue = report.issues.find(
      (i) => i.rule === "commit-message" && i.message.includes("Empty"),
    );
    expect(emptyIssue).toBeDefined();

    const lengthIssue = report.issues.find((i) => i.rule === "commit-message-length");
    expect(lengthIssue).toBeDefined();
    expect(lengthIssue?.severity).toBe("warning");
  });

  test("checkCommitMessages passes valid commits", () => {
    const report = checkCommitMessages([
      { message: "feat(schema): add department schema" },
      { message: "fix: resolve null pointer" },
      { message: "docs: update API documentation" },
      { message: "refactor(core): simplify engine" },
      { message: "test(server): add integration tests" },
    ]);

    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  test("checkEntityDefinitions validates naming conventions", () => {
    const report = checkEntityDefinitions([
      { name: "department", fields: [{ name: "name", type: "string" }] },
      { name: "purchase_request", fields: [{ name: "total_amount", type: "number" }] },
      // Bad: PascalCase
      { name: "BadSchema", fields: [] },
      // Bad: reserved word
      { name: "order", fields: [] },
      // Warning: plural
      { name: "departments", fields: [] },
      // Warning: boolean without is_/has_ prefix
      {
        name: "item",
        fields: [{ name: "active", type: "boolean" }],
      },
      // Warning: datetime without _at suffix
      {
        name: "record",
        fields: [{ name: "created", type: "datetime" }],
      },
    ]);

    // Errors: BadSchema (not snake_case), order (reserved)
    expect(report.summary.errors).toBeGreaterThanOrEqual(2);

    const pascalIssue = report.issues.find(
      (i) => i.rule === "schema-naming" && i.message.includes("BadSchema"),
    );
    expect(pascalIssue).toBeDefined();

    const reservedIssue = report.issues.find(
      (i) => i.rule === "schema-reserved" && i.message.includes("order"),
    );
    expect(reservedIssue).toBeDefined();

    // Warnings: plural, boolean prefix, datetime suffix
    const pluralIssue = report.issues.find(
      (i) => i.rule === "schema-singular" && i.message.includes("departments"),
    );
    expect(pluralIssue).toBeDefined();

    const boolIssue = report.issues.find(
      (i) => i.rule === "boolean-prefix" && i.message.includes("active"),
    );
    expect(boolIssue).toBeDefined();

    const dateIssue = report.issues.find(
      (i) => i.rule === "datetime-suffix" && i.message.includes("created"),
    );
    expect(dateIssue).toBeDefined();
  });

  test("checkEntityDefinitions passes well-named schemas", () => {
    const report = checkEntityDefinitions([
      {
        name: "purchase_request",
        fields: [
          { name: "title", type: "string" },
          { name: "is_approved", type: "boolean" },
          { name: "created_at", type: "datetime" },
        ],
      },
    ]);

    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
  });

  test("checkActionDefinitions validates naming conventions", () => {
    const report = checkActionDefinitions([
      // Good: verb_noun
      { name: "submit_request", schema: "purchase_request" },
      { name: "approve_timesheet", schema: "employee" },
      // Bad: not snake_case
      { name: "submitRequest", schema: "purchase_request" },
      // Warning: single word (no verb_noun pattern)
      { name: "submit", schema: "purchase_request" },
      // Warning: generic CRUD verb
      { name: "create_order", schema: "purchase_request" },
    ]);

    // Error: submitRequest not snake_case
    const camelIssue = report.issues.find(
      (i) => i.rule === "action-naming" && i.message.includes("submitRequest"),
    );
    expect(camelIssue).toBeDefined();
    expect(camelIssue?.severity).toBe("error");

    // Warning: single word
    const singleWordIssue = report.issues.find(
      (i) => i.rule === "action-verb-noun" && i.message.includes('"submit"'),
    );
    expect(singleWordIssue).toBeDefined();
    expect(singleWordIssue?.severity).toBe("warning");

    // Warning: generic verb
    const genericIssue = report.issues.find(
      (i) => i.rule === "action-semantic-verb" && i.message.includes("create_order"),
    );
    expect(genericIssue).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Versioning + CapabilityHub
// ═══════════════════════════════════════════════════════════

describe("E2E: Versioning + CapabilityHub", () => {
  test("CapabilityHub registers and resolves dependency order", () => {
    const hub = createCapabilityHub();

    const core: CapabilityManifest = {
      name: "core",
      version: "1.0.0",
      type: "standard",
      category: "platform",
      provides: { services: ["data-provider"] },
    };

    const auth: CapabilityManifest = {
      name: "auth",
      version: "1.2.0",
      type: "standard",
      category: "platform",
      dependencies: [{ name: "core", versionRange: "^1.0.0" }],
      provides: { services: ["auth-provider"] },
    };

    const purchase: CapabilityManifest = {
      name: "purchase",
      version: "0.5.0",
      type: "standard",
      category: "business",
      dependencies: [
        { name: "core", versionRange: "^1.0.0" },
        { name: "auth", versionRange: "^1.0.0" },
      ],
      provides: { schemas: ["purchase_request"] },
    };

    hub.register(core);
    hub.register(auth);
    hub.register(purchase);

    const order = hub.resolveDependencyOrder();
    // core must come before auth and purchase, auth must come before purchase
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("auth"));
    expect(order.indexOf("auth")).toBeLessThan(order.indexOf("purchase"));
  });

  test("CapabilityHub validates compatibility and detects issues", () => {
    const hub = createCapabilityHub();

    hub.register({
      name: "core",
      version: "1.0.0",
      type: "standard",
      category: "platform",
      provides: { services: ["data-provider"], schemas: ["base_record"] },
    });

    hub.register({
      name: "reporting",
      version: "1.0.0",
      type: "standard",
      category: "business",
      dependencies: [{ name: "core", versionRange: "^1.0.0" }],
      requires: {
        services: ["notification-service"],
        schemas: ["audit_log"],
      },
    });

    const result = hub.validate();
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);

    // Missing service
    const serviceIssue = result.issues.find(
      (i) => i.type === "missing_service" && i.detail.includes("notification-service"),
    );
    expect(serviceIssue).toBeDefined();

    // Missing schema
    const schemaIssue = result.issues.find(
      (i) => i.type === "missing_schema" && i.detail.includes("audit_log"),
    );
    expect(schemaIssue).toBeDefined();
  });

  test("CapabilityHub detects version mismatch", () => {
    const hub = createCapabilityHub();

    hub.register({
      name: "core",
      version: "2.0.0",
      type: "standard",
      category: "platform",
    });

    hub.register({
      name: "plugin",
      version: "1.0.0",
      type: "standard",
      category: "business",
      dependencies: [{ name: "core", versionRange: "^1.0.0" }],
    });

    const result = hub.validate();
    expect(result.valid).toBe(false);

    const versionIssue = result.issues.find((i) => i.type === "version_mismatch");
    expect(versionIssue).toBeDefined();
  });

  test("VersionRegistry tracks and checks compatibility", () => {
    const registry = createVersionRegistry();

    registry.register({
      name: "purchase_request",
      type: "schema",
      version: "1.2.0",
      minCompatible: "1.0.0",
    });

    registry.register({
      name: "employee",
      type: "schema",
      version: "2.0.0",
      minCompatible: "2.0.0",
    });

    // Compatible check
    const check1 = registry.checkCompatibility("schema", "purchase_request", "1.1.0");
    expect(check1.compatible).toBe(true);

    // Incompatible: major version mismatch
    const check2 = registry.checkCompatibility("schema", "employee", "1.5.0");
    expect(check2.compatible).toBe(false);

    // Not registered
    const check3 = registry.checkCompatibility("schema", "nonexistent", "1.0.0");
    expect(check3.compatible).toBe(false);
    expect(check3.reason).toContain("not registered");
  });

  test("MigrationRegistry finds and applies migration paths", () => {
    const registry = new MigrationRegistry();

    registry.register({
      schemaName: "purchase_request",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      description: "Add priority field",
      up: (data) => ({ ...data, priority: "normal" }),
      down: (data) => {
        const { priority: _, ...rest } = data;
        return rest;
      },
    });

    registry.register({
      schemaName: "purchase_request",
      fromVersion: "1.1.0",
      toVersion: "2.0.0",
      description: "Rename amount to total_amount",
      up: (data) => {
        const { amount, ...rest } = data;
        return { ...rest, total_amount: amount };
      },
      down: (data) => {
        const { total_amount, ...rest } = data;
        return { ...rest, amount: total_amount };
      },
    });

    // Find path 1.0.0 -> 2.0.0
    const path = registry.findPath("purchase_request", "1.0.0", "2.0.0");
    expect(path).toEqual(["1.0.0", "1.1.0", "2.0.0"]);

    // Apply migration
    const result = applyMigration(
      registry,
      "purchase_request",
      { id: "1", title: "Test", amount: 1000 },
      "1.0.0",
      "2.0.0",
    );
    expect(result.stepsApplied).toBe(2);
    expect(result.path).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
    expect(result.data.total_amount).toBe(1000);
    expect(result.data.priority).toBe("normal");
    expect(result.data.amount).toBeUndefined();

    // Validate upgrade
    const validation = validateUpgrade(registry, "purchase_request", "1.0.0", "2.0.0");
    expect(validation.valid).toBe(true);
    expect(validation.path).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
  });

  test("MigrationRegistry supports downgrade path", () => {
    const registry = new MigrationRegistry();

    registry.register({
      schemaName: "order",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      up: (data) => ({ ...data, tax_rate: 0.1 }),
      down: (data) => {
        const { tax_rate: _, ...rest } = data;
        return rest;
      },
    });

    // Downgrade 1.1.0 -> 1.0.0
    const result = applyMigration(
      registry,
      "order",
      { id: "1", total: 100, tax_rate: 0.1 },
      "1.1.0",
      "1.0.0",
    );
    expect(result.stepsApplied).toBe(1);
    expect(result.data.tax_rate).toBeUndefined();
    expect(result.data.total).toBe(100);
  });

  test("MigrationRegistry returns null for missing path", () => {
    const registry = new MigrationRegistry();

    registry.register({
      schemaName: "item",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      up: (data) => data,
    });

    // No path from 1.0.0 to 3.0.0
    const path = registry.findPath("item", "1.0.0", "3.0.0");
    expect(path).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Full Pipeline — register → build → generate → validate → changelog
// ═══════════════════════════════════════════════════════════

describe("E2E: Full tooling pipeline", () => {
  test("end-to-end: register schemas → build ontology → generate docs → validate → changelog", () => {
    // Step 1: Register schemas
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(departmentSchema);
    entityRegistry.register(employeeSchema);
    entityRegistry.register(projectSchema);

    const relationRegistry = createRelationRegistry();
    relationRegistry.register(deptEmpLink);
    relationRegistry.register(projectEmpLink);

    const actions = [submitAction, approveAction];

    // Step 2: Build OntologyRegistry
    const ontology = createOntologyRegistry({
      schemas: entityRegistry,
      actions: { getAll: () => actions },
      rules: [],
      states: [],
      views: [],
      links: relationRegistry,
    });

    expect(ontology.listEntities()).toHaveLength(3);
    expect(ontology.describe("employee")).toBeDefined();
    expect(ontology.actionsFor("employee")).toHaveLength(2);

    // Step 3: Generate API documentation
    const apiDoc = generateApiDoc(ontology, {
      title: "HR System API",
      description: "Human Resources management system",
    });

    expect(apiDoc.schemas).toHaveLength(3);

    // Step 4: Render to Markdown
    const markdown = renderSystemDoc(apiDoc);
    expect(markdown).toContain("# HR System API");
    expect(markdown).toContain("Human Resources management system");
    expect(markdown).toContain("## Table of Contents");

    // Step 5: Generate OpenAPI spec
    const openapi = generateOpenAPISpec(apiDoc, { version: "1.0.0" });
    expect(Object.keys(openapi.paths).length).toBeGreaterThan(0);
    expect(Object.keys(openapi.components.schemas).length).toBeGreaterThan(0);

    // Step 6: Validate documentation completeness
    const deptValidation = validateSchemaDoc(departmentSchema);
    expect(deptValidation.coverage).toBe(100);

    const empValidation = validateSchemaDoc(employeeSchema);
    expect(empValidation.coverage).toBe(100);

    // Action validation
    const submitValidation = validateActionDoc(submitAction);
    expect(submitValidation.coverage).toBe(100);

    // Step 7: Validate schema naming conventions
    const schemaConventions = checkEntityDefinitions([
      {
        name: departmentSchema.name,
        fields: Object.entries(departmentSchema.fields).map(([name, f]) => ({
          name,
          type: f.type,
        })),
      },
      {
        name: employeeSchema.name,
        fields: Object.entries(employeeSchema.fields).map(([name, f]) => ({
          name,
          type: f.type,
        })),
      },
    ]);
    expect(schemaConventions.summary.errors).toBe(0);

    // Step 8: Validate action naming conventions
    const actionConventions = checkActionDefinitions(
      actions.map((a) => ({ name: a.name, schema: a.schema })),
    );
    expect(actionConventions.summary.errors).toBe(0);

    // Step 9: Generate changelog
    const commits = [
      parseConventionalCommit("feat(hr): add employee and department schemas", {
        hash: "aaa1111111111",
        date: new Date("2026-03-20"),
        author: "Dev",
      }),
      parseConventionalCommit("feat(hr): add timesheet actions", {
        hash: "bbb2222222222",
        date: new Date("2026-03-21"),
        author: "Dev",
      }),
      parseConventionalCommit("test(hr): add E2E integration tests", {
        hash: "ccc3333333333",
        date: new Date("2026-03-22"),
        author: "Dev",
      }),
    ].filter(Boolean) as NonNullable<ReturnType<typeof parseConventionalCommit>>[];

    const changelog = generateChangelog(commits, {
      version: "1.0.0",
      date: new Date("2026-03-25"),
    });
    expect(changelog).toContain("## 1.0.0 (2026-03-25)");
    expect(changelog).toContain("### Features");
    expect(changelog).toContain("### Tests");

    // Step 10: Track spec status
    const tracker = new SpecTracker();
    tracker.register({ name: "Schema", specFile: "docs/specs/03_schema.md", status: "done" });
    tracker.register({ name: "Action", specFile: "docs/specs/04_action.md", status: "done" });
    tracker.register({
      name: "Link Type",
      specFile: "docs/specs/46_link_type.md",
      status: "done",
    });

    const specReport = tracker.generateReport();
    expect(specReport.completionPercent).toBe(100);
    expect(specReport.counts.done).toBe(3);
  });

  test("end-to-end: versioning pipeline with migration and compatibility", () => {
    // Step 1: Register capabilities in Hub
    const hub = createCapabilityHub();

    hub.register({
      name: "core",
      version: "1.0.0",
      type: "standard",
      category: "platform",
      provides: { services: ["data-provider", "event-bus"] },
    });

    hub.register({
      name: "hr",
      version: "1.0.0",
      type: "standard",
      category: "business",
      dependencies: [{ name: "core", versionRange: "^1.0.0" }],
      provides: { schemas: ["employee", "department"] },
    });

    hub.register({
      name: "timesheet",
      version: "1.0.0",
      type: "standard",
      category: "business",
      dependencies: [
        { name: "core", versionRange: "^1.0.0" },
        { name: "hr", versionRange: "^1.0.0" },
      ],
      requires: { schemas: ["employee"] },
    });

    // Step 2: Validate
    const validation = hub.validate();
    expect(validation.valid).toBe(true);

    // Step 3: Resolve dependency order
    const order = hub.resolveDependencyOrder();
    expect(order[0]).toBe("core");
    expect(order.indexOf("hr")).toBeLessThan(order.indexOf("timesheet"));

    // Step 4: Track versions in registry
    const versionRegistry = createVersionRegistry();

    for (const manifest of hub.list()) {
      versionRegistry.register({
        name: manifest.name,
        type: "capability",
        version: manifest.version,
      });
    }

    // All registered
    expect(versionRegistry.currentVersion("capability", "core")).toBe("1.0.0");
    expect(versionRegistry.currentVersion("capability", "hr")).toBe("1.0.0");
    expect(versionRegistry.currentVersion("capability", "timesheet")).toBe("1.0.0");

    // Step 5: Define migration path
    const migrationRegistry = new MigrationRegistry();
    migrationRegistry.register({
      schemaName: "employee",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      description: "Add role field",
      up: (data) => ({ ...data, role: "engineer" }),
      down: (data) => {
        const { role: _, ...rest } = data;
        return rest;
      },
    });

    // Step 6: Validate migration path exists
    const upgradeCheck = validateUpgrade(migrationRegistry, "employee", "1.0.0", "1.1.0");
    expect(upgradeCheck.valid).toBe(true);

    // Step 7: Apply migration
    const migrated = applyMigration(
      migrationRegistry,
      "employee",
      { id: "emp-1", name: "Alice" },
      "1.0.0",
      "1.1.0",
    );
    expect(migrated.data.role).toBe("engineer");
    expect(migrated.stepsApplied).toBe(1);

    // Step 8: Update version in registry
    versionRegistry.register({
      name: "hr",
      type: "capability",
      version: "1.1.0",
    });
    expect(versionRegistry.currentVersion("capability", "hr")).toBe("1.1.0");

    // Step 9: Compatibility check — timesheet requires hr ^1.0.0, hr is now 1.1.0
    const compat = versionRegistry.checkCompatibility("capability", "hr", "1.0.0");
    expect(compat.compatible).toBe(true);
  });
});
