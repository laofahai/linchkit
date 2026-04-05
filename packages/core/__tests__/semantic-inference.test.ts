import { describe, expect, it } from "bun:test";
import { buildRelationGraph, inferSemanticRelations } from "../src/ontology/semantic-inference";
import type { CapabilityDefinition } from "../src/types/capability";
import { defineSemanticRelation as defineRelation } from "../src/types/semantic-relation";

// ── Fixtures ─────────────────────────────────────────────

const capA: CapabilityDefinition = {
  name: "hr_management",
  label: "HR Management",
  type: "standard",
  category: "business",
  version: "1.0.0",
  dependencies: ["employee_core"],
  entities: [
    {
      name: "leave_request",
      label: "Leave Request",
      fields: {
        employee_id: { type: "ref", target: "employee", label: "Employee" },
        project_refs: { type: "has_many", target: "project", label: "Projects" },
      },
    },
  ],
  actions: [
    {
      name: "submit_leave",
      entity: "leave_request",
      label: "Submit Leave",
      input: {},
      policy: { mode: "sync" },
      handler: async () => {},
    },
  ],
  rules: [
    {
      name: "check_leave_balance",
      label: "Check Leave Balance",
      trigger: { action: "submit_leave" },
      context: {
        balance: { query: "leave_balance" },
      },
      condition: { type: "code", fn: async () => true },
      effect: { type: "allow" },
    },
  ],
  flows: [],
  eventHandlers: [],
};

const capB: CapabilityDefinition = {
  name: "project_management",
  label: "Project Management",
  type: "standard",
  category: "business",
  version: "1.0.0",
  entities: [
    {
      name: "project",
      label: "Project",
      fields: {
        name: { type: "string", label: "Name" },
      },
    },
    {
      name: "leave_balance",
      label: "Leave Balance",
      fields: {
        days: { type: "number", label: "Days" },
      },
    },
  ],
  actions: [
    {
      name: "create_project",
      entity: "project",
      label: "Create Project",
      input: {},
      policy: { mode: "sync" },
      handler: async () => {},
    },
  ],
  eventHandlers: [
    {
      name: "on_leave_submitted",
      label: "On Leave Submitted",
      listen: ["leave_request.submit.succeeded"],
      handler: async () => {},
    },
  ],
  flows: [
    {
      name: "project_approval_flow",
      label: "Project Approval Flow",
      trigger: { type: "event", eventType: "project.create.succeeded" },
      steps: [
        {
          id: "step1",
          name: "Notify HR",
          type: "action",
          actionName: "submit_leave",
        },
      ],
    },
  ],
};

const bridgeCap: CapabilityDefinition = {
  name: "hr_project_bridge",
  label: "HR Project Bridge",
  type: "bridge",
  category: "business",
  version: "1.0.0",
  bridges: [{ capability: "hr_management" }, { capability: "project_management" }],
  entities: [],
  actions: [],
};

const employeeCore: CapabilityDefinition = {
  name: "employee_core",
  label: "Employee Core",
  type: "standard",
  category: "business",
  version: "1.0.0",
  entities: [
    {
      name: "employee",
      label: "Employee",
      fields: { name: { type: "string", label: "Name" } },
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────

describe("inferSemanticRelations", () => {
  const caps = [capA, capB, bridgeCap, employeeCore];

  it("infers depends_on from capability.dependencies", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const dep = rels.find(
      (r) =>
        r.type === "depends_on" &&
        r.from.capability === "hr_management" &&
        r.to.capability === "employee_core",
    );
    expect(dep).toBeDefined();
    expect(dep?.source).toBe("capability_dependency");
  });

  it("infers references from schema ref fields", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const ref = rels.find(
      (r) =>
        r.type === "references" && r.from.entity === "leave_request" && r.to.entity === "employee",
    );
    expect(ref).toBeDefined();
    expect(ref?.source).toBe("schema_ref");
    expect(ref?.inferredFrom).toBe("leave_request.employee_id");
  });

  it("infers contains from schema has_many fields", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const contains = rels.find(
      (r) =>
        r.type === "contains" && r.from.entity === "leave_request" && r.to.entity === "project",
    );
    expect(contains).toBeDefined();
    expect(contains?.source).toBe("schema_has_many");
  });

  it("infers bridges from bridge capability", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const bridge = rels.find(
      (r) =>
        r.type === "bridges" &&
        r.from.capability === "hr_project_bridge" &&
        r.to.capability === "hr_management",
    );
    expect(bridge).toBeDefined();
    expect(bridge?.source).toBe("bridge_definition");
  });

  it("infers affects from bridge capability (cross-bridge)", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const affects = rels.find(
      (r) =>
        r.type === "affects" &&
        r.source === "bridge_definition" &&
        r.from.capability === "hr_management" &&
        r.to.capability === "project_management",
    );
    expect(affects).toBeDefined();
    expect(affects?.source).toBe("bridge_definition");
  });

  it("infers triggers from cross-module EventHandler", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const triggers = rels.find(
      (r) =>
        r.type === "triggers" &&
        r.from.capability === "hr_management" &&
        r.to.capability === "project_management",
    );
    expect(triggers).toBeDefined();
    expect(triggers?.source).toBe("event_handler");
    expect(triggers?.inferredFrom).toBe("on_leave_submitted");
  });

  it("infers orchestrates from cross-module Flow steps", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const orch = rels.find(
      (r) =>
        r.type === "orchestrates" &&
        r.from.capability === "project_management" &&
        r.to.entity === "leave_request",
    );
    expect(orch).toBeDefined();
    expect(orch?.source).toBe("flow_step");
  });

  it("infers reads_from from Rule context queries", () => {
    const rels = inferSemanticRelations({ capabilities: caps });
    const reads = rels.find(
      (r) =>
        r.type === "reads_from" &&
        r.from.entity === "leave_request" &&
        r.to.entity === "leave_balance",
    );
    expect(reads).toBeDefined();
    expect(reads?.source).toBe("rule_context");
  });

  it("deduplicates identical relations", () => {
    const rels = inferSemanticRelations({ capabilities: [capA, capA, employeeCore] });
    const deps = rels.filter(
      (r) =>
        r.type === "depends_on" &&
        r.from.capability === "hr_management" &&
        r.to.capability === "employee_core",
    );
    expect(deps.length).toBe(1);
  });
});

describe("buildRelationGraph", () => {
  const caps = [capA, capB, bridgeCap, employeeCore];

  it("returns a RelationGraph with all inferred relations", () => {
    const graph = buildRelationGraph(caps);
    expect(graph.relations.length).toBeGreaterThan(0);
  });

  it("merges manual relations with inferred ones", () => {
    const manual = defineRelation({
      type: "conflicts_with",
      from: { capability: "hr_management", entity: "leave_request" },
      to: { capability: "project_management", entity: "project" },
    });
    const graph = buildRelationGraph(caps, [manual]);
    const conflict = graph.relations.find((r) => r.type === "conflicts_with");
    expect(conflict).toBeDefined();
    expect(conflict?.source).toBe("manual");
  });

  it("outgoing() returns relations from the given endpoint", () => {
    const graph = buildRelationGraph(caps);
    const out = graph.outgoing({ capability: "hr_management" });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.from.capability).toBe("hr_management");
    }
  });

  it("incoming() returns relations to the given endpoint", () => {
    const graph = buildRelationGraph(caps);
    const inc = graph.incoming({ capability: "employee_core" });
    expect(inc.length).toBeGreaterThan(0);
    for (const r of inc) {
      expect(r.to.capability).toBe("employee_core");
    }
  });

  it("forCapability() returns all relations involving the capability", () => {
    const graph = buildRelationGraph(caps);
    const all = graph.forCapability("hr_management");
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      const involved = r.from.capability === "hr_management" || r.to.capability === "hr_management";
      expect(involved).toBe(true);
    }
  });

  it("forEntity() returns all relations involving the schema", () => {
    const graph = buildRelationGraph(caps);
    const all = graph.forEntity("leave_request");
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      const involved = r.from.entity === "leave_request" || r.to.entity === "leave_request";
      expect(involved).toBe(true);
    }
  });
});

describe("defineRelation", () => {
  it("creates a manual relation with auto-generated id", () => {
    const rel = defineRelation({
      type: "conflicts_with",
      from: { capability: "cap_a", entity: "schema_x" },
      to: { capability: "cap_b", entity: "schema_y" },
      description: "test",
    });
    expect(rel.id).toBeTruthy();
    expect(rel.source).toBe("manual");
    expect(rel.type).toBe("conflicts_with");
  });
});
