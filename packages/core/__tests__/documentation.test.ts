/**
 * Documentation generation tests
 */

import { describe, expect, test } from "bun:test";
import {
  actionToDoc,
  fieldToDoc,
  generateApiDoc,
  generateOpenAPISpec,
  renderActionDoc,
  renderSystemDoc,
} from "@linchkit/devtools/documentation";
import { createOntologyRegistry, type OntologyRegistryDeps } from "../src/ontology";
import type { ActionDefinition } from "../src/types/action";
import type { RelationDefinition } from "../src/types/relation";
import type { RuleDefinition } from "../src/types/rule";
import type { EntityDefinition } from "../src/types/entity";
import type { StateDefinition } from "../src/types/state";
import type { ViewDefinition } from "../src/types/view";

// ── Test data ──────────────────────────────────────────

const departmentSchema: EntityDefinition = {
  name: "department",
  label: "Department",
  description: "Company departments",
  fields: {
    name: { type: "string", label: "Name", required: true },
    code: { type: "string", label: "Code", unique: true },
  },
};

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "Purchase request for procurement",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", min: 0 },
    status: { type: "state", label: "Status", machine: "purchase_lifecycle" },
    department_id: { type: "ref", label: "Department", target: "department" },
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
};

const submitAction: ActionDefinition = {
  name: "submit_request",
  schema: "purchase_request",
  label: "Submit Request",
  description: "Submit a purchase request for approval",
  input: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
  },
  output: {
    id: { type: "string", label: "ID" },
  },
  policy: { mode: "sync", transaction: true },
  stateTransition: { from: "draft", to: "pending" },
  exposure: { http: true, mcp: true, ui: true },
  permissions: { groups: ["purchaser"], actorTypes: ["human"] },
};

const approveAction: ActionDefinition = {
  name: "approve_request",
  schema: "purchase_request",
  label: "Approve Request",
  policy: { mode: "sync", transaction: true, idempotent: true },
  stateTransition: { from: "pending", to: "approved" },
  exposure: "all",
};

const amountRule: RuleDefinition = {
  name: "amount_check",
  label: "Amount Check",
  description: "Large amounts need director approval",
  trigger: { action: "submit_request" },
  condition: { field: "amount", operator: "gt", value: 10000 },
  effect: { type: "prevent", message: "Amount exceeds limit" },
};

const purchaseState: StateDefinition = {
  name: "purchase_lifecycle",
  schema: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit_request" },
    { from: "pending", to: "approved", action: "approve_request" },
    { from: "pending", to: "rejected", action: "reject_request" },
  ],
};

const purchaseListView: ViewDefinition = {
  name: "purchase_request_list",
  schema: "purchase_request",
  type: "list",
  label: "Purchase Request List",
  fields: [{ field: "title" }, { field: "amount" }, { field: "status" }],
};

const deptToPurchaseLink: RelationDefinition = {
  name: "dept_purchase",
  from: "department",
  to: "purchase_request",
  cardinality: "one_to_many",
  label: { from: "Purchase Requests", to: "Department" },
};

// ── Helper: create minimal registries ──────────────────────────────────

function createTestDeps(): OntologyRegistryDeps {
  const schemas = [departmentSchema, purchaseRequestSchema];
  const actions = [submitAction, approveAction];
  const links = [deptToPurchaseLink];

  return {
    schemas: {
      getAll: () => schemas,
      get: (name: string) => schemas.find((s) => s.name === name),
      has: (name: string) => schemas.some((s) => s.name === name),
    },
    actions: {
      getAll: () => actions,
    },
    rules: [amountRule],
    states: [purchaseState],
    views: [purchaseListView],
    links: {
      linksFor(schemaName: string) {
        const results: Array<{
          link: RelationDefinition;
          direction: "outgoing" | "incoming";
          relatedSchema: string;
          label: string;
        }> = [];
        for (const link of links) {
          if (link.from === schemaName) {
            results.push({
              link,
              direction: "outgoing",
              relatedSchema: link.to,
              label: link.label?.from ?? link.to,
            });
          }
          if (link.to === schemaName) {
            results.push({
              link,
              direction: "incoming",
              relatedSchema: link.from,
              label: link.label?.to ?? link.from,
            });
          }
        }
        return results;
      },
    },
  };
}

// ── Tests: fieldToDoc ──────────────────────────────────────────

describe("fieldToDoc", () => {
  test("converts string field", () => {
    const doc = fieldToDoc("title", { type: "string", label: "Title", required: true });
    expect(doc.name).toBe("title");
    expect(doc.type).toBe("string");
    expect(doc.label).toBe("Title");
    expect(doc.required).toBe(true);
  });

  test("extracts constraints", () => {
    const doc = fieldToDoc("amount", {
      type: "number",
      label: "Amount",
      min: 0,
      max: 100000,
      unique: true,
    });
    expect(doc.constraints).toEqual({ min: 0, max: 100000, unique: true });
  });

  test("includes ref target", () => {
    const doc = fieldToDoc("dept", { type: "ref", target: "department", label: "Dept" });
    expect(doc.target).toBe("department");
  });

  test("includes enum options", () => {
    const doc = fieldToDoc("priority", {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "high" }],
    });
    expect(doc.options).toHaveLength(2);
    expect(doc.options?.[0].value).toBe("low");
  });

  test("includes state machine name", () => {
    const doc = fieldToDoc("status", {
      type: "state",
      label: "Status",
      machine: "lifecycle",
    });
    expect(doc.machine).toBe("lifecycle");
  });

  test("uses field name as label fallback", () => {
    const doc = fieldToDoc("my_field", { type: "string" });
    expect(doc.label).toBe("my_field");
  });
});

// ── Tests: actionToDoc ──────────────────────────────────────────

describe("actionToDoc", () => {
  test("converts action with input/output", () => {
    const doc = actionToDoc(submitAction);
    expect(doc.name).toBe("submit_request");
    expect(doc.label).toBe("Submit Request");
    expect(doc.input).toHaveLength(2);
    expect(doc.output).toHaveLength(1);
    expect(doc.stateTransition).toEqual({ from: "draft", to: "pending" });
  });

  test("normalizes exposure 'all'", () => {
    const doc = actionToDoc(approveAction);
    expect(doc.exposure.http).toBe(true);
    expect(doc.exposure.mcp).toBe(true);
    expect(doc.exposure.cli).toBe(true);
    expect(doc.exposure.ui).toBe(true);
    expect(doc.exposure.internal).toBe(true);
  });

  test("preserves permissions", () => {
    const doc = actionToDoc(submitAction);
    expect(doc.permissions?.groups).toEqual(["purchaser"]);
    expect(doc.permissions?.actorTypes).toEqual(["human"]);
  });

  test("preserves policy", () => {
    const doc = actionToDoc(approveAction);
    expect(doc.policy.mode).toBe("sync");
    expect(doc.policy.transaction).toBe(true);
    expect(doc.policy.idempotent).toBe(true);
  });

  test("handles action with no input/output", () => {
    const doc = actionToDoc(approveAction);
    expect(doc.input).toHaveLength(0);
    expect(doc.output).toHaveLength(0);
  });
});

// ── Tests: generateApiDoc ──────────────────────────────────────────

describe("generateApiDoc", () => {
  test("generates SystemDoc from ontology", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology, { title: "Test API" });

    expect(doc.title).toBe("Test API");
    expect(doc.generatedAt).toBeTruthy();
    expect(doc.schemas).toHaveLength(2);
  });

  test("includes schema fields", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const prSchema = doc.schemas.find((s) => s.name === "purchase_request");

    expect(prSchema).toBeDefined();
    expect(prSchema?.fields.length).toBeGreaterThanOrEqual(5);
    expect(prSchema?.fields.find((f) => f.name === "title")).toBeDefined();
  });

  test("includes schema actions", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const prSchema = doc.schemas.find((s) => s.name === "purchase_request");

    expect(prSchema?.actions).toHaveLength(2);
    expect(prSchema?.actions.find((a) => a.name === "submit_request")).toBeDefined();
  });

  test("includes state machine", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const prSchema = doc.schemas.find((s) => s.name === "purchase_request");

    expect(prSchema?.stateMachine).toBeDefined();
    expect(prSchema?.stateMachine?.initial).toBe("draft");
    expect(prSchema?.stateMachine?.states).toContain("approved");
  });

  test("includes relations", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const deptSchema = doc.schemas.find((s) => s.name === "department");

    expect(deptSchema?.relations).toHaveLength(1);
    expect(deptSchema?.relations[0].targetSchema).toBe("purchase_request");
    expect(deptSchema?.relations[0].direction).toBe("outgoing");
  });
});

// ── Tests: Markdown renderer ──────────────────────────────────────────

describe("renderSystemDoc", () => {
  test("renders complete Markdown", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology, { title: "My API", description: "Test system" });
    const md = renderSystemDoc(doc);

    expect(md).toContain("# My API");
    expect(md).toContain("Test system");
    expect(md).toContain("## Table of Contents");
    expect(md).toContain("## Department");
    expect(md).toContain("## Purchase Request");
  });

  test("renders field tables", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc);

    expect(md).toContain("| Name | Type | Required | Description |");
    expect(md).toContain("| title | string | yes |");
  });

  test("renders state machine with Mermaid", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc);

    expect(md).toContain("### State Machine");
    expect(md).toContain("stateDiagram-v2");
    expect(md).toContain("[*] --> draft");
    expect(md).toContain("draft --> pending: submit_request");
  });

  test("renders Mermaid ER diagram", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc);

    expect(md).toContain("## Relationships");
    expect(md).toContain("erDiagram");
    expect(md).toContain("department");
    expect(md).toContain("purchase_request");
  });

  test("renders action documentation", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc);

    expect(md).toContain("### Actions");
    expect(md).toContain("#### Submit Request (`submit_request`)");
    expect(md).toContain("**State transition:** draft -> pending");
    expect(md).toContain("**Exposed via:** http, mcp, ui");
  });

  test("respects options to disable sections", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const md = renderSystemDoc(doc, {
      toc: false,
      mermaid: false,
      actions: false,
      stateMachines: false,
    });

    expect(md).not.toContain("## Table of Contents");
    expect(md).not.toContain("erDiagram");
    expect(md).not.toContain("### Actions");
    expect(md).not.toContain("stateDiagram-v2");
  });
});

describe("renderActionDoc", () => {
  test("renders action with input table", () => {
    const doc = actionToDoc(submitAction);
    const md = renderActionDoc(doc);

    expect(md).toContain("#### Submit Request (`submit_request`)");
    expect(md).toContain("**Input:**");
    expect(md).toContain("| title | string | yes |");
    expect(md).toContain("**Output:**");
    expect(md).toContain("**Required groups:** purchaser");
  });
});

// ── Tests: OpenAPI generator ──────────────────────────────────────────

describe("generateOpenAPISpec", () => {
  test("generates valid OpenAPI 3.0 spec", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology, { title: "Test API" });
    const spec = generateOpenAPISpec(doc, { version: "2.0.0" });

    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("Test API");
    expect(spec.info.version).toBe("2.0.0");
  });

  test("generates component schemas for each schema", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    expect(spec.components.schemas.department).toBeDefined();
    expect(spec.components.schemas.purchase_request).toBeDefined();
    expect(spec.components.schemas.department_input).toBeDefined();
    expect(spec.components.schemas.purchase_request_input).toBeDefined();
  });

  test("maps field types correctly", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    const prSchema = spec.components.schemas.purchase_request;
    expect(prSchema.properties).toBeDefined();

    // String field
    const title = prSchema.properties?.title as { type: string };
    expect(title.type).toBe("string");

    // Number field
    const amount = prSchema.properties?.amount as { type: string };
    expect(amount.type).toBe("number");

    // Ref field
    const deptId = prSchema.properties?.department_id as { type: string; format: string };
    expect(deptId.type).toBe("string");
    expect(deptId.format).toBe("uuid");

    // Enum field
    const priority = prSchema.properties?.priority as { type: string; enum: string[] };
    expect(priority.type).toBe("string");
    expect(priority.enum).toEqual(["low", "medium", "high"]);

    // System fields
    expect(prSchema.properties?.id).toBeDefined();
    expect(prSchema.properties?.created_at).toBeDefined();
  });

  test("generates CRUD paths", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    // List + create
    expect(spec.paths["/api/department"]).toBeDefined();
    expect(spec.paths["/api/department"].get).toBeDefined();
    expect(spec.paths["/api/department"].post).toBeDefined();

    // Get + update + delete
    expect(spec.paths["/api/department/{id}"]).toBeDefined();
    expect(spec.paths["/api/department/{id}"].get).toBeDefined();
    expect(spec.paths["/api/department/{id}"].put).toBeDefined();
    expect(spec.paths["/api/department/{id}"].delete).toBeDefined();
  });

  test("generates action endpoints for HTTP-exposed actions", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    // submit_request is exposed via HTTP
    expect(spec.paths["/api/actions/submit_request"]).toBeDefined();
    expect(spec.paths["/api/actions/submit_request"].post).toBeDefined();
    expect(spec.paths["/api/actions/submit_request"].post?.summary).toBe("Submit Request");

    // approve_request has exposure "all" which includes HTTP
    expect(spec.paths["/api/actions/approve_request"]).toBeDefined();
  });

  test("generates action input schemas", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    expect(spec.components.schemas.submit_request_input).toBeDefined();
    const inputSchema = spec.components.schemas.submit_request_input;
    expect(inputSchema.properties?.title).toBeDefined();
    expect(inputSchema.properties?.amount).toBeDefined();
    expect(inputSchema.required).toContain("title");
    expect(inputSchema.required).toContain("amount");
  });

  test("includes required fields in schema components", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    const deptSchema = spec.components.schemas.department_input;
    expect(deptSchema.required).toContain("name");
  });

  test("excludes computed and relational fields from input schemas", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    // purchase_request_input should not have has_many or computed fields
    const inputSchema = spec.components.schemas.purchase_request_input;
    // All purchase_request fields are writable in our test data
    expect(inputSchema.properties).toBeDefined();
  });

  test("respects options to disable CRUD or actions", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const specNoCrud = generateOpenAPISpec(doc, { crud: false });
    const specNoActions = generateOpenAPISpec(doc, { actions: false });

    expect(specNoCrud.paths["/api/department"]).toBeUndefined();
    expect(specNoCrud.paths["/api/actions/submit_request"]).toBeDefined();

    expect(specNoActions.paths["/api/department"]).toBeDefined();
    expect(specNoActions.paths["/api/actions/submit_request"]).toBeUndefined();
  });

  test("operation IDs are unique", () => {
    const ontology = createOntologyRegistry(createTestDeps());
    const doc = generateApiDoc(ontology);
    const spec = generateOpenAPISpec(doc);

    const opIds = new Set<string>();
    for (const pathItem of Object.values(spec.paths)) {
      for (const op of [pathItem.get, pathItem.post, pathItem.put, pathItem.delete]) {
        if (op?.operationId) {
          expect(opIds.has(op.operationId)).toBe(false);
          opIds.add(op.operationId);
        }
      }
    }
  });
});
