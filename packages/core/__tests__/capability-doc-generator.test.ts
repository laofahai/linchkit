/**
 * Capability doc generator and doc search tests
 *
 * Tests per-capability spec document generation, Markdown rendering,
 * and full-text documentation search across capabilities.
 */

import { describe, expect, test } from "bun:test";
import {
  createDocSearchIndex,
  DocSearchIndex,
  generateCapabilityDoc,
  renderCapabilityDoc,
} from "@linchkit/devtools/documentation";
import type { CapabilityDefinition } from "../src/types/capability";

// ── Test data ──────────────────────────────────

const purchaseCapability: CapabilityDefinition = {
  name: "cap-purchase",
  label: "Purchase Management",
  description: "Handles purchase requests and approvals",
  type: "standard",
  category: "business",
  version: "1.2.0",
  dependencies: ["cap-employee"],
  entities: [
    {
      name: "purchase_request",
      label: "Purchase Request",
      description: "Purchase request for procurement",
      fields: {
        title: { type: "string", label: "Title", required: true },
        amount: { type: "number", label: "Amount", required: true, min: 0 },
        department_id: { type: "string", label: "Department", description: "FK to department" },
        status: { type: "state", label: "Status", machine: "purchase_lifecycle" },
        priority: {
          type: "enum",
          label: "Priority",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
      },
    },
  ],
  actions: [
    {
      name: "create_request",
      entity: "purchase_request",
      label: "Create Request",
      description: "Creates a new purchase request",
      policy: { mode: "sync", transaction: true },
    },
    {
      name: "submit_request",
      entity: "purchase_request",
      label: "Submit Request",
      description: "Submit for approval",
      policy: { mode: "sync", transaction: true },
      stateTransition: { from: "draft", to: "submitted" },
    },
    {
      name: "approve_request",
      entity: "purchase_request",
      label: "Approve Request",
      description: "Approve the purchase request",
      policy: { mode: "sync", transaction: true },
      stateTransition: { from: "submitted", to: "approved" },
    },
  ],
  rules: [
    {
      name: "amount_check",
      label: "Amount Check",
      description: "Large amounts need director approval",
      trigger: { action: "submit_request" },
      condition: { field: "amount", operator: "gt", value: 10000 },
      effect: { type: "prevent", message: "Amount exceeds limit" },
    },
  ],
  states: [
    {
      name: "purchase_lifecycle",
      entity: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved", "purchased", "completed"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit_request" },
        { from: "submitted", to: "approved", action: "approve_request" },
      ],
    },
  ],
  views: [
    {
      name: "purchase_request_list",
      entity: "purchase_request",
      type: "list",
      label: "Purchase Request List",
      fields: [{ field: "title" }, { field: "amount" }, { field: "status" }],
    },
    {
      name: "purchase_request_form",
      entity: "purchase_request",
      type: "form",
      label: "Purchase Request Form",
      fields: [{ field: "title" }, { field: "amount" }, { field: "department_id" }],
    },
  ],
  relations: [
    {
      name: "dept_purchase",
      from: "department",
      to: "purchase_request",
      cardinality: "one_to_many",
      fromName: "purchase_requests",
      toName: "department",
      label: { from: "Purchase Requests", to: "Department" },
    },
  ],
};

const employeeCapability: CapabilityDefinition = {
  name: "cap-employee",
  label: "Employee Management",
  description: "Manages employees and departments",
  type: "standard",
  category: "business",
  version: "1.0.0",
  entities: [
    {
      name: "employee",
      label: "Employee",
      description: "Company employee",
      fields: {
        name: { type: "string", label: "Name", required: true },
        email: { type: "string", label: "Email", required: true },
      },
    },
    {
      name: "department",
      label: "Department",
      description: "Company department",
      fields: {
        name: { type: "string", label: "Name", required: true },
        code: { type: "string", label: "Code" },
      },
    },
  ],
  actions: [
    {
      name: "create_employee",
      entity: "employee",
      label: "Create Employee",
      description: "Add a new employee",
      policy: { mode: "sync", transaction: true },
    },
  ],
};

const minimalCapability: CapabilityDefinition = {
  name: "cap-minimal",
  label: "Minimal",
  type: "standard",
  category: "business",
  version: "0.1.0",
};

// ── Tests: generateCapabilityDoc ──────────────────────────────────

describe("generateCapabilityDoc", () => {
  test("generates complete capability spec from definition", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.name).toBe("cap-purchase");
    expect(doc.label).toBe("Purchase Management");
    expect(doc.version).toBe("1.2.0");
    expect(doc.description).toBe("Handles purchase requests and approvals");
    expect(doc.type).toBe("standard");
    expect(doc.category).toBe("business");
    expect(doc.generatedAt).toBeTruthy();
  });

  test("includes schema documentation with fields", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]?.name).toBe("purchase_request");
    expect(doc.entities[0]?.fields.length).toBeGreaterThanOrEqual(5);

    const titleField = doc.entities[0]?.fields.find((f) => f.name === "title");
    expect(titleField).toBeDefined();
    expect(titleField?.type).toBe("string");
    expect(titleField?.required).toBe(true);

    // department_id is a plain string FK field (relations are declared via defineRelation)
    const fkField = doc.entities[0]?.fields.find((f) => f.name === "department_id");
    expect(fkField?.type).toBe("string");
  });

  test("includes action documentation with state transitions", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.actions).toHaveLength(3);
    const submit = doc.actions.find((a) => a.name === "submit_request");
    expect(submit?.stateTransition).toEqual({ from: "draft", to: "submitted" });
  });

  test("includes rule documentation", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0]?.name).toBe("amount_check");
    expect(doc.rules[0]?.description).toBe("Large amounts need director approval");
  });

  test("includes state machine documentation", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.stateMachines).toHaveLength(1);
    expect(doc.stateMachines[0]?.name).toBe("purchase_lifecycle");
    expect(doc.stateMachines[0]?.initial).toBe("draft");
    expect(doc.stateMachines[0]?.states).toContain("approved");
    expect(doc.stateMachines[0]?.transitions).toHaveLength(2);
  });

  test("includes view documentation", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.views).toHaveLength(2);
    expect(doc.views.find((v) => v.name === "purchase_request_list")).toBeDefined();
    expect(doc.views.find((v) => v.type === "form")).toBeDefined();
  });

  test("includes dependency list", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    expect(doc.dependencies).toEqual(["cap-employee"]);
  });

  test("includes relation documentation", () => {
    const doc = generateCapabilityDoc(purchaseCapability);

    expect(doc.relations).toHaveLength(1);
    expect(doc.relations[0]?.relationName).toBe("dept_purchase");
    expect(doc.relations[0]?.from).toBe("department");
    expect(doc.relations[0]?.to).toBe("purchase_request");
    expect(doc.relations[0]?.cardinality).toBe("one_to_many");
  });

  test("handles minimal capability with no schemas/actions", () => {
    const doc = generateCapabilityDoc(minimalCapability);

    expect(doc.name).toBe("cap-minimal");
    expect(doc.entities).toHaveLength(0);
    expect(doc.actions).toHaveLength(0);
    expect(doc.rules).toHaveLength(0);
    expect(doc.stateMachines).toHaveLength(0);
    expect(doc.views).toHaveLength(0);
    expect(doc.dependencies).toHaveLength(0);
    expect(doc.relations).toHaveLength(0);
  });
});

// ── Tests: renderCapabilityDoc ──────────────────────────────────

describe("renderCapabilityDoc", () => {
  test("renders Markdown with header and metadata", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("# Purchase Management v1.2.0");
    expect(md).toContain("> Handles purchase requests and approvals");
    expect(md).toContain("**Type:** standard");
    expect(md).toContain("**Category:** business");
  });

  test("renders schema section with fields", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Entities");
    expect(md).toContain("**purchase_request**");
    expect(md).toContain("title (string, required)");
    expect(md).toContain("amount (number, required)");
    expect(md).toContain("department_id (string)");
  });

  test("renders action section with state transitions", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Actions");
    expect(md).toContain("**submit_request**");
    expect(md).toContain("(draft -> submitted)");
  });

  test("renders rules section", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Rules");
    expect(md).toContain("**amount_check**");
  });

  test("renders state machine with Mermaid diagram", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## State Machines");
    expect(md).toContain("stateDiagram-v2");
    expect(md).toContain("[*] --> draft");
    expect(md).toContain("draft --> submitted: submit_request");
  });

  test("renders views section", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Views");
    expect(md).toContain("**purchase_request_list** (list)");
  });

  test("renders dependencies section", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Dependencies");
    expect(md).toContain("- cap-employee");
  });

  test("renders relations section", () => {
    const doc = generateCapabilityDoc(purchaseCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("## Relations");
    expect(md).toContain("**dept_purchase**");
    expect(md).toContain("department -> purchase_request");
    expect(md).toContain("one_to_many");
  });

  test("omits empty sections for minimal capability", () => {
    const doc = generateCapabilityDoc(minimalCapability);
    const md = renderCapabilityDoc(doc);

    expect(md).toContain("# Minimal v0.1.0");
    expect(md).not.toContain("## Entities");
    expect(md).not.toContain("## Actions");
    expect(md).not.toContain("## Rules");
    expect(md).not.toContain("## State Machines");
    expect(md).not.toContain("## Views");
    expect(md).not.toContain("## Dependencies");
    expect(md).not.toContain("## Relations");
  });
});

// ── Tests: DocSearchIndex ──────────────────────────────────

describe("DocSearchIndex", () => {
  test("indexes capabilities and returns size", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability]);
    // capability entries + schema entries + action entries + rule + state machine + views + relation
    expect(index.size).toBeGreaterThan(10);
  });

  test("searches by schema name", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability]);
    const results = index.search("purchase_request");

    expect(results.length).toBeGreaterThan(0);
    // Should find the schema itself
    const schemaResult = results.find((r) => r.type === "entity" && r.name === "purchase_request");
    expect(schemaResult).toBeDefined();
    expect(schemaResult?.capability).toBe("cap-purchase");
  });

  test("searches by action name", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("submit_request");

    const actionResult = results.find((r) => r.type === "action" && r.name === "submit_request");
    expect(actionResult).toBeDefined();
  });

  test("searches by keyword in description", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("approval");

    expect(results.length).toBeGreaterThan(0);
    // Should match the capability description "Handles purchase requests and approvals"
    const capResult = results.find((r) => r.type === "capability");
    expect(capResult).toBeDefined();
  });

  test("searches by field name", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("amount");

    // Should find purchase_request schema because it has an "amount" field
    const schemaResult = results.find((r) => r.type === "entity");
    expect(schemaResult).toBeDefined();
  });

  test("filters by element type", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability]);
    const results = index.search("purchase", { type: "action" });

    for (const r of results) {
      expect(r.type).toBe("action");
    }
  });

  test("filters by capability name", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability]);
    const results = index.search("name", { capability: "cap-employee" });

    for (const r of results) {
      expect(r.capability).toBe("cap-employee");
    }
    expect(results.length).toBeGreaterThan(0);
  });

  test("limits results count", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability]);
    const results = index.search("purchase", { limit: 3 });

    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("sorts results by relevance score descending", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("purchase");

    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.score).toBeLessThanOrEqual(results[i - 1]?.score);
    }
  });

  test("returns empty array for no matches", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("xyznonexistent");

    expect(results).toHaveLength(0);
  });

  test("returns empty array for empty query", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("");

    expect(results).toHaveLength(0);
  });

  test("handles multi-word queries", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("purchase request");

    expect(results.length).toBeGreaterThan(0);
    // Multi-word match should score higher than single-word
    const topResult = results[0];
    expect(topResult?.score).toBeGreaterThan(1);
  });

  test("searches state machines by state name", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("draft");

    const smResult = results.find((r) => r.type === "state_machine");
    expect(smResult).toBeDefined();
  });

  test("searches relations", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("dept_purchase");

    const relResult = results.find((r) => r.type === "relation");
    expect(relResult).toBeDefined();
    expect(relResult?.name).toBe("dept_purchase");
  });

  test("searches views", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    const results = index.search("list");

    const viewResult = results.find((r) => r.type === "view");
    expect(viewResult).toBeDefined();
  });

  test("clear() resets the index", () => {
    const index = createDocSearchIndex([purchaseCapability]);
    expect(index.size).toBeGreaterThan(0);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.search("purchase")).toHaveLength(0);
  });

  test("addCapability appends to existing index", () => {
    const index = new DocSearchIndex();
    index.addCapability(purchaseCapability);
    const sizeBefore = index.size;

    index.addCapability(employeeCapability);
    expect(index.size).toBeGreaterThan(sizeBefore);
  });
});

// ── Tests: createDocSearchIndex factory ──────────────────

describe("createDocSearchIndex", () => {
  test("creates index from empty array", () => {
    const index = createDocSearchIndex([]);
    expect(index.size).toBe(0);
  });

  test("creates populated index from capabilities", () => {
    const index = createDocSearchIndex([purchaseCapability, employeeCapability, minimalCapability]);
    expect(index.size).toBeGreaterThan(0);

    // Should find items from all capabilities
    const purchaseResults = index.search("purchase");
    const employeeResults = index.search("employee");
    const minimalResults = index.search("minimal");

    expect(purchaseResults.length).toBeGreaterThan(0);
    expect(employeeResults.length).toBeGreaterThan(0);
    expect(minimalResults.length).toBeGreaterThan(0);
  });
});
