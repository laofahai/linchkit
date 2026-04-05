/**
 * OntologyRegistry unit tests
 */

import { describe, expect, test } from "bun:test";
import { createOntologyRegistry, type OntologyRegistryDeps } from "../src/ontology";
import type { ActionDefinition } from "../src/types/action";
import type { EventHandlerDefinition } from "../src/types/event";
import type { FlowDefinition } from "../src/types/flow";
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
    code: { type: "string", label: "Code" },
  },
};

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "Purchase request for procurement",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount" },
    status: { type: "state", label: "Status", machine: "purchase_request" },
    department_id: { type: "ref", label: "Department", target: "department" },
  },
  presentation: {
    titleField: "title",
    badgeField: "status",
    icon: "file-text",
  },
};

const submitAction: ActionDefinition = {
  name: "submit_request",
  entity: "purchase_request",
  label: "Submit Request",
  description: "Submit a purchase request for approval",
  policy: { mode: "sync", transaction: true },
  stateTransition: { from: "draft", to: "pending" },
};

const approveAction: ActionDefinition = {
  name: "approve_request",
  entity: "purchase_request",
  label: "Approve Request",
  policy: { mode: "sync", transaction: true },
  stateTransition: { from: "pending", to: "approved" },
};

const budgetRule: RuleDefinition = {
  name: "budget_check",
  label: "Budget Check",
  description: "Block requests over budget",
  trigger: { stateChange: { entity: "purchase_request", to: "pending" } },
  condition: { field: "amount", operator: "gt", value: 10000 },
  effect: { type: "require_approval", level: "manager" },
};

const purchaseState: StateDefinition = {
  name: "purchase_request_state",
  entity: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit_request" },
    { from: "pending", to: "approved", action: "approve_request" },
    { from: "pending", to: "rejected", action: "reject_request" },
  ],
};

const listView: ViewDefinition = {
  name: "purchase_request_list",
  entity: "purchase_request",
  type: "list",
  label: "Purchase Requests",
  fields: [{ field: "title" }, { field: "amount" }, { field: "status" }],
};

const formView: ViewDefinition = {
  name: "purchase_request_form",
  entity: "purchase_request",
  type: "form",
  label: "Purchase Request Form",
  fields: [
    { field: "title" },
    { field: "amount" },
    { field: "department_id" },
    { field: "status", readonly: true },
  ],
};

const approvalFlow: FlowDefinition = {
  name: "purchase_approval",
  label: "Purchase Approval Flow",
  trigger: { type: "event", eventType: "purchase_request.submit_request.succeeded" },
  steps: [
    { id: "check", name: "Check Amount", type: "action", actionName: "submit_request" },
    { id: "approve", name: "Manager Approval", type: "approval", approvers: ["manager"] },
  ],
};

// ── Helpers ──────────────────────────────────────────────

function createMockEntityRegistry(schemas: EntityDefinition[]) {
  const map = new Map(schemas.map((s) => [s.name, s]));
  return {
    getAll: () => schemas,
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
  };
}

function createMockActionRegistry(actions: ActionDefinition[]) {
  return { getAll: () => actions };
}

function createMockRelationRegistry(links: RelationDefinition[]) {
  return {
    relationsFor: (entityName: string) => {
      const result: Array<{
        relation: RelationDefinition;
        direction: "outgoing" | "incoming";
        relatedEntity: string;
        label: string;
      }> = [];
      for (const link of links) {
        if (link.from === entityName) {
          result.push({
            relation: link,
            direction: "outgoing",
            relatedEntity: link.to,
            label: link.label?.from ?? link.to,
          });
        }
        if (link.to === entityName) {
          result.push({
            relation: link,
            direction: "incoming",
            relatedEntity: link.from,
            label: link.label?.to ?? link.from,
          });
        }
      }
      return result;
    },
  };
}

function createMockFlowRegistry(flows: FlowDefinition[]) {
  return { getAll: () => flows };
}

function createMockHandlerRegistry(handlers: EventHandlerDefinition[]) {
  return { getAll: () => handlers };
}

const deptPurchaseLink: RelationDefinition = {
  name: "department_purchase_request",
  from: "purchase_request",
  to: "department",
  cardinality: "many_to_one",
  label: { from: "Department", to: "Purchase Requests" },
};

function buildDeps(overrides?: Partial<OntologyRegistryDeps>): OntologyRegistryDeps {
  return {
    schemas: createMockEntityRegistry([departmentSchema, purchaseRequestSchema]),
    actions: createMockActionRegistry([submitAction, approveAction]),
    rules: [budgetRule],
    states: [purchaseState],
    views: [listView, formView],
    links: createMockRelationRegistry([deptPurchaseLink]),
    flows: createMockFlowRegistry([approvalFlow]),
    handlers: createMockHandlerRegistry([]),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────

describe("OntologyRegistry", () => {
  describe("listEntities", () => {
    test("returns all schema names", () => {
      const registry = createOntologyRegistry(buildDeps());
      const names = registry.listEntities();
      expect(names).toContain("department");
      expect(names).toContain("purchase_request");
      expect(names).toHaveLength(2);
    });
  });

  describe("describe", () => {
    test("returns undefined for unknown schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      expect(registry.describe("nonexistent")).toBeUndefined();
    });

    test("returns complete descriptor for purchase_request", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc).toBeDefined();
      expect(desc?.name).toBe("purchase_request");
      expect(desc?.label).toBe("Purchase Request");
      expect(desc?.description).toBe("Purchase request for procurement");
      expect(desc?.fields.title).toBeDefined();
      expect(desc?.fields.amount).toBeDefined();
      expect(desc?.presentation?.titleField).toBe("title");
    });

    test("includes actions for the schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.actions).toHaveLength(2);
      expect(desc?.actions.map((a) => a.name)).toContain("submit_request");
      expect(desc?.actions.map((a) => a.name)).toContain("approve_request");
    });

    test("includes rules for the schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.rules).toHaveLength(1);
      expect(desc?.rules[0].name).toBe("budget_check");
    });

    test("includes state machine for the schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.states).toBeDefined();
      expect(desc?.states?.initial).toBe("draft");
      expect(desc?.states?.states).toContain("approved");
    });

    test("includes views for the schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.views).toHaveLength(2);
      expect(desc?.views.map((v) => v.type)).toContain("list");
      expect(desc?.views.map((v) => v.type)).toContain("form");
    });

    test("includes relations from links", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.relations).toHaveLength(1);
      expect(desc?.relations[0].relationName).toBe("department_purchase_request");
      expect(desc?.relations[0].direction).toBe("outgoing");
      expect(desc?.relations[0].targetEntity).toBe("department");
      expect(desc?.relations[0].cardinality).toBe("many_to_one");
    });

    test("shows incoming relations on department", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("department");

      expect(desc?.relations).toHaveLength(1);
      expect(desc?.relations[0].direction).toBe("incoming");
      expect(desc?.relations[0].targetEntity).toBe("purchase_request");
    });

    test("includes flows for the schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc = registry.describe("purchase_request");

      expect(desc?.flows).toHaveLength(1);
      expect(desc?.flows[0].name).toBe("purchase_approval");
    });

    test("caches results", () => {
      const registry = createOntologyRegistry(buildDeps());
      const desc1 = registry.describe("purchase_request");
      const desc2 = registry.describe("purchase_request");
      expect(desc1).toBe(desc2); // Same reference (cached)
    });
  });

  describe("actionsFor", () => {
    test("returns actions for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const actions = registry.actionsFor("purchase_request");
      expect(actions).toHaveLength(2);
    });

    test("returns empty array for schema with no actions", () => {
      const registry = createOntologyRegistry(buildDeps());
      const actions = registry.actionsFor("department");
      expect(actions).toHaveLength(0);
    });

    test("returns empty array for unknown schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const actions = registry.actionsFor("nonexistent");
      expect(actions).toHaveLength(0);
    });
  });

  describe("rulesFor", () => {
    test("returns rules for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const rules = registry.rulesFor("purchase_request");
      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("budget_check");
    });

    test("returns empty array for schema with no rules", () => {
      const registry = createOntologyRegistry(buildDeps());
      const rules = registry.rulesFor("department");
      expect(rules).toHaveLength(0);
    });
  });

  describe("stateFor", () => {
    test("returns state definition for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const state = registry.stateFor("purchase_request");
      expect(state).toBeDefined();
      expect(state?.initial).toBe("draft");
    });

    test("returns undefined for schema with no state", () => {
      const registry = createOntologyRegistry(buildDeps());
      const state = registry.stateFor("department");
      expect(state).toBeUndefined();
    });
  });

  describe("viewsFor", () => {
    test("returns views for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const views = registry.viewsFor("purchase_request");
      expect(views).toHaveLength(2);
    });
  });

  describe("flowsFor", () => {
    test("returns flows for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const flows = registry.flowsFor("purchase_request");
      expect(flows).toHaveLength(1);
    });

    test("returns empty for schema with no flows", () => {
      const registry = createOntologyRegistry(buildDeps());
      const flows = registry.flowsFor("department");
      expect(flows).toHaveLength(0);
    });
  });

  describe("relatedSchemas", () => {
    test("returns relations for a schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const relations = registry.relatedEntities("purchase_request");
      expect(relations).toHaveLength(1);
      expect(relations[0].targetEntity).toBe("department");
    });

    test("returns empty for unknown schema", () => {
      const registry = createOntologyRegistry(buildDeps());
      const relations = registry.relatedEntities("nonexistent");
      expect(relations).toHaveLength(0);
    });
  });

  describe("searchSchemas", () => {
    test("matches by schema name", () => {
      const registry = createOntologyRegistry(buildDeps());
      const results = registry.searchEntities("purchase");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("purchase_request");
    });

    test("matches by label", () => {
      const registry = createOntologyRegistry(buildDeps());
      const results = registry.searchEntities("Company departments");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("department");
    });

    test("matches by field name", () => {
      const registry = createOntologyRegistry(buildDeps());
      const results = registry.searchEntities("amount");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("purchase_request");
    });

    test("case insensitive search", () => {
      const registry = createOntologyRegistry(buildDeps());
      const results = registry.searchEntities("PURCHASE");
      expect(results).toHaveLength(1);
    });

    test("returns empty for no match", () => {
      const registry = createOntologyRegistry(buildDeps());
      const results = registry.searchEntities("nonexistent_xyz");
      expect(results).toHaveLength(0);
    });
  });

  describe("toJSON", () => {
    test("returns all schemas as descriptors", () => {
      const registry = createOntologyRegistry(buildDeps());
      const json = registry.toJSON();

      expect(Object.keys(json)).toHaveLength(2);
      expect(json.department).toBeDefined();
      expect(json.purchase_request).toBeDefined();
      expect(json.purchase_request.actions).toHaveLength(2);
    });
  });

  describe("toMarkdown", () => {
    test("generates markdown output", () => {
      const registry = createOntologyRegistry(buildDeps());
      const md = registry.toMarkdown();

      expect(md).toContain("# Ontology");
      expect(md).toContain("## Purchase Request");
      expect(md).toContain("## Department");
      expect(md).toContain("### Fields");
      expect(md).toContain("**title**");
      expect(md).toContain("`string`");
      expect(md).toContain("### Actions");
      expect(md).toContain("**submit_request**");
      expect(md).toContain("### State Machine");
      expect(md).toContain("draft");
    });

    test("includes relations in markdown", () => {
      const registry = createOntologyRegistry(buildDeps());
      const md = registry.toMarkdown();

      expect(md).toContain("### Relations");
      expect(md).toContain("department");
    });
  });

  describe("handlersFor", () => {
    test("returns empty when no handlers registered", () => {
      const registry = createOntologyRegistry(buildDeps());
      const handlers = registry.handlersFor("purchase_request");
      expect(handlers).toHaveLength(0);
    });

    test("returns handlers matching schema event convention", () => {
      const handler: EventHandlerDefinition = {
        name: "notify_on_submit",
        listen: "purchase_request.submit_request.succeeded",
        handler: async () => {},
      };

      const registry = createOntologyRegistry(
        buildDeps({
          handlers: createMockHandlerRegistry([handler]),
        }),
      );

      const handlers = registry.handlersFor("purchase_request");
      expect(handlers).toHaveLength(1);
      expect(handlers[0].name).toBe("notify_on_submit");
    });
  });

  describe("works with minimal deps (no optional registries)", () => {
    test("works without links, flows, handlers", () => {
      const registry = createOntologyRegistry({
        schemas: createMockEntityRegistry([departmentSchema]),
        actions: createMockActionRegistry([]),
        rules: [],
        states: [],
        views: [],
      });

      const desc = registry.describe("department");
      expect(desc).toBeDefined();
      expect(desc?.relations).toHaveLength(0);
      expect(desc?.flows).toHaveLength(0);
      expect(desc?.handlers).toHaveLength(0);
    });
  });
});
