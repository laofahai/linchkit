import { describe, expect, it } from "bun:test";
import { createOntologyRegistry } from "../src/ontology/ontology-registry";
import { createInterfaceRegistry } from "../src/entity/entity-interface";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { InterfaceDefinition, EntityDefinition } from "../src/types/entity";
import type { StateDefinition } from "../src/types/state";

// ── Test fixtures ───────────────────────────────────────

const approvableInterface: InterfaceDefinition = {
  name: "approvable",
  label: "Approvable",
  description: "Schemas implementing this interface support approval workflows",
  fields: {
    status: {
      type: "string",
      default: "draft",
    },
    approver_id: { type: "ref", target: "user", required: false },
    approved_at: { type: "datetime", required: false },
    rejection_reason: { type: "text", required: false },
  },
  state: {
    initial: "draft",
    transitions: [
      { from: "draft", to: "submitted", action: "submit" },
      { from: "submitted", to: "approved", action: "approve" },
      { from: "submitted", to: "rejected", action: "reject" },
    ],
  },
  actions: {
    submit: { label: "Submit", requiredFields: ["status"] },
    approve: { label: "Approve", requiredFields: ["status", "approver_id"] },
  },
};

const archivableInterface: InterfaceDefinition = {
  name: "archivable",
  label: "Archivable",
  fields: {
    is_archived: { type: "boolean", default: false },
    archived_at: { type: "datetime", required: false },
  },
};

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  implements: ["approvable"],
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number", required: true },
  },
};

const leaveRequestSchema: EntityDefinition = {
  name: "leave_request",
  label: "Leave Request",
  implements: ["approvable", "archivable"],
  fields: {
    reason: { type: "text", required: true },
    days: { type: "number", required: true },
  },
};

// ── InterfaceRegistry Tests ───────────────────────────────────

describe("InterfaceRegistry", () => {
  describe("register", () => {
    it("registers an interface and retrieves it", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      expect(registry.get("approvable")).toBe(approvableInterface);
    });

    it("returns undefined for unregistered interface", () => {
      const registry = createInterfaceRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("throws on duplicate registration", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      expect(() => registry.register(approvableInterface)).toThrow(
        'Interface "approvable" is already registered',
      );
    });

    it("throws on interface without name", () => {
      const registry = createInterfaceRegistry();
      expect(() =>
        registry.register({ name: "", label: "X", fields: { x: { type: "string" } } }),
      ).toThrow("Interface must have a name");
    });

    it("throws on interface without label", () => {
      const registry = createInterfaceRegistry();
      expect(() =>
        registry.register({ name: "x", label: "", fields: { x: { type: "string" } } }),
      ).toThrow('Interface "x" must have a label');
    });

    it("throws on interface without fields", () => {
      const registry = createInterfaceRegistry();
      expect(() => registry.register({ name: "x", label: "X", fields: {} })).toThrow(
        'Interface "x" must have at least one field',
      );
    });
  });

  describe("has", () => {
    it("returns true for registered interface", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);
      expect(registry.has("approvable")).toBe(true);
    });

    it("returns false for unregistered interface", () => {
      const registry = createInterfaceRegistry();
      expect(registry.has("approvable")).toBe(false);
    });
  });

  describe("list", () => {
    it("lists all registered interfaces", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);
      registry.register(archivableInterface);

      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all).toContain(approvableInterface);
      expect(all).toContain(archivableInterface);
    });
  });

  describe("implementors and interfacesOf", () => {
    it("tracks schema-interface relationships", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);
      registry.register(archivableInterface);

      registry.registerImplementor("purchase_request", ["approvable"]);
      registry.registerImplementor("leave_request", ["approvable", "archivable"]);

      // implementors
      expect(registry.implementors("approvable")).toEqual(
        expect.arrayContaining(["purchase_request", "leave_request"]),
      );
      expect(registry.implementors("archivable")).toEqual(["leave_request"]);
      expect(registry.implementors("nonexistent")).toEqual([]);

      // interfacesOf
      const prInterfaces = registry.interfacesOf("purchase_request");
      expect(prInterfaces).toHaveLength(1);
      expect(prInterfaces[0]?.name).toBe("approvable");

      const lrInterfaces = registry.interfacesOf("leave_request");
      expect(lrInterfaces).toHaveLength(2);

      expect(registry.interfacesOf("nonexistent")).toEqual([]);
    });

    it("implements() check works correctly", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      registry.registerImplementor("purchase_request", ["approvable"]);

      expect(registry.implements("purchase_request", "approvable")).toBe(true);
      expect(registry.implements("purchase_request", "archivable")).toBe(false);
      expect(registry.implements("nonexistent", "approvable")).toBe(false);
    });
  });

  describe("validateImplementation", () => {
    it("returns no errors for valid implementation", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      const errors = registry.validateImplementation(purchaseRequestSchema);
      expect(errors).toEqual([]);
    });

    it("errors when interface does not exist", () => {
      const registry = createInterfaceRegistry();
      // Do not register the interface

      const schema: EntityDefinition = {
        name: "test",
        implements: ["nonexistent"],
        fields: { x: { type: "string" } },
      };

      const errors = registry.validateImplementation(schema);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("nonexistent");
      expect(errors[0]).toContain("not registered");
    });

    it("errors when schema field type conflicts with interface field type", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      const schema: EntityDefinition = {
        name: "bad_schema",
        implements: ["approvable"],
        fields: {
          title: { type: "string" },
          // status is string in interface, but number here
          status: { type: "number" },
        },
      };

      const errors = registry.validateImplementation(schema);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("status");
      expect(errors[0]).toContain("number");
      expect(errors[0]).toContain("string");
    });

    it("errors when two interfaces have same field with different types", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface); // has status: string

      const conflictingInterface: InterfaceDefinition = {
        name: "conflicting",
        label: "Conflicting",
        fields: {
          status: { type: "number" }, // conflicts with approvable's status: string
        },
      };
      registry.register(conflictingInterface);

      const schema: EntityDefinition = {
        name: "test",
        implements: ["approvable", "conflicting"],
        fields: { x: { type: "string" } },
      };

      const errors = registry.validateImplementation(schema);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("incompatible types");
    });

    it("allows schema to override interface field defaults (same type)", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      const schema: EntityDefinition = {
        name: "test",
        implements: ["approvable"],
        fields: {
          title: { type: "string" },
          // Override status with same type but different default
          status: { type: "string", default: "pending" },
        },
      };

      const errors = registry.validateImplementation(schema);
      expect(errors).toEqual([]);
    });

    it("returns empty for schema without implements", () => {
      const registry = createInterfaceRegistry();
      const schema: EntityDefinition = {
        name: "test",
        fields: { x: { type: "string" } },
      };
      expect(registry.validateImplementation(schema)).toEqual([]);
    });
  });

  describe("getInjectedFields", () => {
    it("returns interface fields not defined by schema", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      const injected = registry.getInjectedFields(purchaseRequestSchema);

      // purchase_request has title and amount, does not have status/approver_id/approved_at/rejection_reason
      expect(Object.keys(injected)).toEqual(
        expect.arrayContaining(["status", "approver_id", "approved_at", "rejection_reason"]),
      );
      expect(injected.status?.type).toBe("string");
    });

    it("does not inject fields already defined in schema", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);

      const schema: EntityDefinition = {
        name: "test",
        implements: ["approvable"],
        fields: {
          title: { type: "string" },
          status: { type: "string", default: "custom" }, // already defined
        },
      };

      const injected = registry.getInjectedFields(schema);
      expect("status" in injected).toBe(false);
      expect("approver_id" in injected).toBe(true);
    });

    it("merges fields from multiple interfaces", () => {
      const registry = createInterfaceRegistry();
      registry.register(approvableInterface);
      registry.register(archivableInterface);

      const injected = registry.getInjectedFields(leaveRequestSchema);

      expect("status" in injected).toBe(true);
      expect("is_archived" in injected).toBe(true);
      expect("archived_at" in injected).toBe(true);
    });

    it("returns empty for schema without implements", () => {
      const registry = createInterfaceRegistry();
      const schema: EntityDefinition = {
        name: "test",
        fields: { x: { type: "string" } },
      };
      expect(registry.getInjectedFields(schema)).toEqual({});
    });
  });
});

// ── EntityRegistry + InterfaceRegistry integration ───────────────

describe("EntityRegistry with InterfaceRegistry", () => {
  it("validates interface implementation on register", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    // This should not throw — valid implementation
    entityRegistry.register(purchaseRequestSchema);
  });

  it("throws on register when interface does not exist", () => {
    const ifaceRegistry = createInterfaceRegistry();
    // Do not register any interfaces

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "bad",
      implements: ["nonexistent"],
      fields: { x: { type: "string" } },
    };

    expect(() => entityRegistry.register(schema)).toThrow("nonexistent");
  });

  it("throws on register when field type conflicts", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "bad",
      implements: ["approvable"],
      fields: {
        title: { type: "string" },
        status: { type: "number" }, // conflicts
      },
    };

    expect(() => entityRegistry.register(schema)).toThrow("status");
  });

  it("injects interface fields during resolve", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);
    entityRegistry.register(purchaseRequestSchema);

    const resolved = entityRegistry.resolve("purchase_request");

    // Interface fields should be present
    expect(resolved.fields.status).toBeDefined();
    expect(resolved.fields.status.definition.type).toBe("string");
    expect(resolved.fields.approver_id).toBeDefined();
    expect(resolved.fields.approved_at).toBeDefined();
    expect(resolved.fields.rejection_reason).toBeDefined();

    // Schema's own fields should also be present
    expect(resolved.fields.title).toBeDefined();
    expect(resolved.fields.amount).toBeDefined();

    // implements should be in resolved
    expect(resolved.implements).toEqual(["approvable"]);
  });

  it("schema field overrides interface field default", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "custom",
      implements: ["approvable"],
      fields: {
        title: { type: "string" },
        status: { type: "string", default: "custom_default" },
      },
    };
    entityRegistry.register(schema);

    const resolved = entityRegistry.resolve("custom");
    // Schema's own definition wins
    expect(resolved.fields.status.definition.default).toBe("custom_default");
  });

  it("injects fields from multiple interfaces", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);
    ifaceRegistry.register(archivableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);
    entityRegistry.register(leaveRequestSchema);

    const resolved = entityRegistry.resolve("leave_request");

    // From approvable
    expect(resolved.fields.status).toBeDefined();
    expect(resolved.fields.approver_id).toBeDefined();

    // From archivable
    expect(resolved.fields.is_archived).toBeDefined();
    expect(resolved.fields.archived_at).toBeDefined();

    // Own fields
    expect(resolved.fields.reason).toBeDefined();
    expect(resolved.fields.days).toBeDefined();

    expect(resolved.implements).toEqual(["approvable", "archivable"]);
  });

  it("registers implementors in InterfaceRegistry on schema register", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);
    ifaceRegistry.register(archivableInterface);

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);
    entityRegistry.register(purchaseRequestSchema);
    entityRegistry.register(leaveRequestSchema);

    expect(ifaceRegistry.implementors("approvable")).toEqual(
      expect.arrayContaining(["purchase_request", "leave_request"]),
    );
    expect(ifaceRegistry.implementors("archivable")).toEqual(["leave_request"]);
  });

  it("works without InterfaceRegistry set (backward compatible)", () => {
    const entityRegistry = createEntityRegistry();

    // Schema with implements but no InterfaceRegistry — should register fine
    const schema: EntityDefinition = {
      name: "test",
      implements: ["approvable"],
      fields: { x: { type: "string" } },
    };
    entityRegistry.register(schema);

    const resolved = entityRegistry.resolve("test");
    expect(resolved.fields.x).toBeDefined();
    expect(resolved.implements).toEqual(["approvable"]);
  });
});

// ── OntologyRegistry integration ───────────────────────────

describe("OntologyRegistry with interfaces", () => {
  it("includes interfaces in schema descriptor", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);
    ifaceRegistry.register(archivableInterface);
    ifaceRegistry.registerImplementor("purchase_request", ["approvable"]);
    ifaceRegistry.registerImplementor("leave_request", ["approvable", "archivable"]);

    const entityRegistry = createEntityRegistry();
    entityRegistry.register(purchaseRequestSchema);
    entityRegistry.register(leaveRequestSchema);

    const ontology = createOntologyRegistry({
      schemas: entityRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      interfaces: ifaceRegistry,
    });

    const prDesc = ontology.describe("purchase_request");
    expect(prDesc).toBeDefined();
    expect(prDesc?.interfaces).toHaveLength(1);
    expect(prDesc?.interfaces[0]?.name).toBe("approvable");

    const lrDesc = ontology.describe("leave_request");
    expect(lrDesc).toBeDefined();
    expect(lrDesc?.interfaces).toHaveLength(2);
  });

  it("schemasImplementing returns correct schemas", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);
    ifaceRegistry.registerImplementor("purchase_request", ["approvable"]);
    ifaceRegistry.registerImplementor("leave_request", ["approvable"]);

    const entityRegistry = createEntityRegistry();
    entityRegistry.register(purchaseRequestSchema);
    entityRegistry.register(leaveRequestSchema);

    const ontology = createOntologyRegistry({
      schemas: entityRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      interfaces: ifaceRegistry,
    });

    const implementors = ontology.entitiesImplementing("approvable");
    expect(implementors).toEqual(expect.arrayContaining(["purchase_request", "leave_request"]));
    expect(ontology.entitiesImplementing("nonexistent")).toEqual([]);
  });

  it("works without interfaces (backward compatible)", () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register({
      name: "simple",
      fields: { x: { type: "string" } },
    });

    const ontology = createOntologyRegistry({
      schemas: entityRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      // No interfaces provided
    });

    const desc = ontology.describe("simple");
    expect(desc).toBeDefined();
    expect(desc?.interfaces).toEqual([]);
    expect(ontology.entitiesImplementing("anything")).toEqual([]);
  });
});

// ── Enum compatibility validation ───────────────────────────

describe("InterfaceRegistry enum validation", () => {
  it("errors when schema field is missing enum values required by interface", () => {
    const registry = createInterfaceRegistry();
    const iface: InterfaceDefinition = {
      name: "statusable",
      label: "Statusable",
      fields: {
        status: {
          type: "string",
          enum: ["draft", "active", "archived"],
        },
      },
    };
    registry.register(iface);

    const schema: EntityDefinition = {
      name: "my_schema",
      implements: ["statusable"],
      fields: {
        // Schema overrides enum but misses "archived"
        status: { type: "string", enum: ["draft", "active"] },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("archived");
    expect(errors[0]).toContain("missing value");
  });

  it("allows schema to add extra enum values beyond interface requirements", () => {
    const registry = createInterfaceRegistry();
    const iface: InterfaceDefinition = {
      name: "statusable",
      label: "Statusable",
      fields: {
        status: { type: "string", enum: ["draft", "active"] },
      },
    };
    registry.register(iface);

    const schema: EntityDefinition = {
      name: "my_schema",
      implements: ["statusable"],
      fields: {
        // Schema adds an extra enum value — this is fine (superset)
        status: { type: "string", enum: ["draft", "active", "suspended"] },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors).toEqual([]);
  });

  it("errors when schema omits enum entirely but interface requires it", () => {
    const registry = createInterfaceRegistry();
    const iface: InterfaceDefinition = {
      name: "prioritizable",
      label: "Prioritizable",
      fields: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    };
    registry.register(iface);

    const schema: EntityDefinition = {
      name: "task",
      implements: ["prioritizable"],
      fields: {
        // Schema defines field with same type but no enum
        priority: { type: "string" },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("must define enum");
  });

  it("errors when two interfaces have same field with conflicting enum values", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "iface_a",
      label: "A",
      fields: {
        priority: { type: "string", enum: ["low", "high"] },
      },
    });
    registry.register({
      name: "iface_b",
      label: "B",
      fields: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["iface_a", "iface_b"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.some((e) => e.includes("conflicting enum"))).toBe(true);
  });

  it("no error when two interfaces have same field with identical enum values", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "iface_a",
      label: "A",
      fields: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    });
    registry.register({
      name: "iface_b",
      label: "B",
      fields: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["iface_a", "iface_b"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    // Should have no enum conflict errors (types are same, enums are identical)
    expect(errors.filter((e) => e.includes("enum"))).toEqual([]);
  });
});

// ── Required constraint validation ───────────────────────────

describe("InterfaceRegistry required constraint validation", () => {
  it("errors when schema weakens required=true to required=false", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "named",
      label: "Named",
      fields: {
        display_name: { type: "string", required: true },
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["named"],
      fields: {
        display_name: { type: "string", required: false },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("required");
    expect(errors[0]).toContain("not required");
  });

  it("allows schema to strengthen required=false to required=true", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "named",
      label: "Named",
      fields: {
        display_name: { type: "string", required: false },
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["named"],
      fields: {
        display_name: { type: "string", required: true },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors).toEqual([]);
  });

  it("allows schema field without explicit required when interface has required=true", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "named",
      label: "Named",
      fields: {
        display_name: { type: "string", required: true },
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["named"],
      fields: {
        // required is undefined (not explicitly false), which is acceptable
        display_name: { type: "string" },
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors).toEqual([]);
  });
});

// ── Cross-interface state machine conflict detection ─────────

describe("InterfaceRegistry state machine validation", () => {
  it("errors when two interfaces have conflicting initial states", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "workflow_a",
      label: "Workflow A",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "active", action: "activate" }],
      },
    });
    registry.register({
      name: "workflow_b",
      label: "Workflow B",
      fields: { priority: { type: "string" } },
      state: {
        initial: "new",
        transitions: [{ from: "new", to: "active", action: "activate" }],
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["workflow_a", "workflow_b"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.some((e) => e.includes("conflicting initial states"))).toBe(true);
  });

  it("errors when two interfaces have conflicting transitions (same from+action, different to)", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "flow_a",
      label: "Flow A",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "submitted", action: "submit" }],
      },
    });
    registry.register({
      name: "flow_b",
      label: "Flow B",
      fields: { priority: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "pending", action: "submit" }],
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["flow_a", "flow_b"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.some((e) => e.includes("conflicting transition"))).toBe(true);
  });

  it("no error when two interfaces have compatible state machines", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "flow_a",
      label: "Flow A",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "submitted", action: "submit" }],
      },
    });
    registry.register({
      name: "flow_b",
      label: "Flow B",
      fields: { priority: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [
          // Same initial, non-conflicting transitions
          { from: "submitted", to: "approved", action: "approve" },
        ],
      },
    });

    const schema: EntityDefinition = {
      name: "test",
      implements: ["flow_a", "flow_b"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors).toEqual([]);
  });

  it("no state conflict when only one interface has state", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface); // has state
    registry.register(archivableInterface); // no state

    const schema: EntityDefinition = {
      name: "test",
      implements: ["approvable", "archivable"],
      fields: { x: { type: "string" } },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors).toEqual([]);
  });
});

// ── State compatibility validation (schema state vs interface state) ─

describe("InterfaceRegistry validateStateCompatibility", () => {
  it("returns no errors when schema has no custom state (interface state used as-is)", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface);
    registry.registerImplementor("purchase_request", ["approvable"]);

    const errors = registry.validateStateCompatibility("purchase_request", null);
    expect(errors).toEqual([]);
  });

  it("returns no errors when schema state is a superset of interface state", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface);
    registry.registerImplementor("purchase_request", ["approvable"]);

    const schemaState: StateDefinition = {
      name: "purchase_request_status",
      schema: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved", "rejected", "cancelled"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit" },
        { from: "submitted", to: "approved", action: "approve" },
        { from: "submitted", to: "rejected", action: "reject" },
        // Extra transition not in interface — that's fine
        { from: "draft", to: "cancelled", action: "cancel" },
      ],
    };

    const errors = registry.validateStateCompatibility("purchase_request", schemaState);
    expect(errors).toEqual([]);
  });

  it("errors when schema state has different initial than interface", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface);
    registry.registerImplementor("purchase_request", ["approvable"]);

    const schemaState: StateDefinition = {
      name: "purchase_request_status",
      schema: "purchase_request",
      field: "status",
      initial: "new", // interface expects "draft"
      states: ["new", "submitted", "approved", "rejected"],
      transitions: [
        { from: "new", to: "submitted", action: "submit" },
        { from: "submitted", to: "approved", action: "approve" },
        { from: "submitted", to: "rejected", action: "reject" },
      ],
    };

    const errors = registry.validateStateCompatibility("purchase_request", schemaState);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('initial "new"');
    expect(errors[0]).toContain('"draft"');
  });

  it("errors when schema state is missing an interface-required transition", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface);
    registry.registerImplementor("purchase_request", ["approvable"]);

    const schemaState: StateDefinition = {
      name: "purchase_request_status",
      schema: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit" },
        { from: "submitted", to: "approved", action: "approve" },
        // Missing: { from: "submitted", to: "rejected", action: "reject" }
      ],
    };

    const errors = registry.validateStateCompatibility("purchase_request", schemaState);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing transition");
    expect(errors[0]).toContain("reject");
  });

  it("returns no errors for schema with no interfaces", () => {
    const registry = createInterfaceRegistry();
    const schemaState: StateDefinition = {
      name: "test_status",
      schema: "test",
      field: "status",
      initial: "draft",
      states: ["draft"],
      transitions: [],
    };

    const errors = registry.validateStateCompatibility("test", schemaState);
    expect(errors).toEqual([]);
  });

  it("validates against multiple interfaces with state", () => {
    const registry = createInterfaceRegistry();
    // Register two interfaces with compatible but distinct state templates
    registry.register({
      name: "submittable",
      label: "Submittable",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "submitted", action: "submit" }],
      },
    });
    registry.register({
      name: "reviewable",
      label: "Reviewable",
      fields: { reviewer: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "submitted", to: "reviewed", action: "review" }],
      },
    });
    registry.registerImplementor("doc", ["submittable", "reviewable"]);

    // Schema state must include both transitions
    const schemaState: StateDefinition = {
      name: "doc_status",
      schema: "doc",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "reviewed"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit" },
        // Missing: review transition
      ],
    };

    const errors = registry.validateStateCompatibility("doc", schemaState);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("review");
    expect(errors[0]).toContain("reviewable");
  });

  it("supports array-form 'from' in schema state transitions", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "resetable",
      label: "Resetable",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [
          { from: "active", to: "draft", action: "reset" },
          { from: "paused", to: "draft", action: "reset" },
        ],
      },
    });
    registry.registerImplementor("task", ["resetable"]);

    // Schema uses array-form "from" to express both transitions
    const schemaState: StateDefinition = {
      name: "task_status",
      schema: "task",
      field: "status",
      initial: "draft",
      states: ["draft", "active", "paused"],
      transitions: [{ from: ["active", "paused"], to: "draft", action: "reset" }],
    };

    const errors = registry.validateStateCompatibility("task", schemaState);
    expect(errors).toEqual([]);
  });
});

// ── getMergedStateTemplate ───────────────────────────────────

describe("InterfaceRegistry getMergedStateTemplate", () => {
  it("returns null when no interface has state", () => {
    const registry = createInterfaceRegistry();
    registry.register(archivableInterface); // no state
    registry.registerImplementor("test", ["archivable"]);

    expect(registry.getMergedStateTemplate("test")).toBeNull();
  });

  it("returns single interface state as-is", () => {
    const registry = createInterfaceRegistry();
    registry.register(approvableInterface);
    registry.registerImplementor("test", ["approvable"]);

    const merged = registry.getMergedStateTemplate("test");
    expect(merged).not.toBeNull();
    expect(merged?.initial).toBe("draft");
    expect(merged?.transitions).toHaveLength(3);
  });

  it("merges transitions from multiple interfaces", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "submittable",
      label: "Submittable",
      fields: { status: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "submitted", action: "submit" }],
      },
    });
    registry.register({
      name: "reviewable",
      label: "Reviewable",
      fields: { reviewer: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "submitted", to: "reviewed", action: "review" }],
      },
    });
    registry.registerImplementor("doc", ["submittable", "reviewable"]);

    const merged = registry.getMergedStateTemplate("doc");
    expect(merged).not.toBeNull();
    expect(merged?.initial).toBe("draft");
    expect(merged?.transitions).toHaveLength(2);
    expect(merged?.transitions.some((t) => t.action === "submit")).toBe(true);
    expect(merged?.transitions.some((t) => t.action === "review")).toBe(true);
  });

  it("deduplicates identical transitions from multiple interfaces", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "flow_a",
      label: "Flow A",
      fields: { x: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "active", action: "activate" }],
      },
    });
    registry.register({
      name: "flow_b",
      label: "Flow B",
      fields: { y: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "active", action: "activate" }],
      },
    });
    registry.registerImplementor("test", ["flow_a", "flow_b"]);

    const merged = registry.getMergedStateTemplate("test");
    expect(merged?.transitions).toHaveLength(1);
  });

  it("returns null for unknown schema", () => {
    const registry = createInterfaceRegistry();
    expect(registry.getMergedStateTemplate("nonexistent")).toBeNull();
  });
});

// ── Multiple validation errors ──────────────────────────────

describe("InterfaceRegistry multiple validation errors", () => {
  it("collects multiple errors in a single validation", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "strict_iface",
      label: "Strict",
      fields: {
        name: { type: "string", required: true },
        priority: { type: "string", enum: ["low", "high"] },
        count: { type: "number" },
      },
    });

    const schema: EntityDefinition = {
      name: "bad_schema",
      implements: ["strict_iface"],
      fields: {
        name: { type: "number" }, // wrong type
        priority: { type: "string", enum: ["low"] }, // missing "high"
        count: { type: "number" }, // ok
      },
    };

    const errors = registry.validateImplementation(schema);
    // Should have at least 2 errors: type mismatch + missing enum value
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.includes("name") && e.includes("number"))).toBe(true);
    expect(errors.some((e) => e.includes("high") && e.includes("missing value"))).toBe(true);
  });

  it("reports both missing interface and field type errors", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "existing_iface",
      label: "Existing",
      fields: { x: { type: "string" } },
    });

    const schema: EntityDefinition = {
      name: "bad_schema",
      implements: ["nonexistent", "existing_iface"],
      fields: {
        x: { type: "number" }, // conflicts with existing_iface
      },
    };

    const errors = registry.validateImplementation(schema);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.includes("not registered"))).toBe(true);
    expect(errors.some((e) => e.includes("number") && e.includes("string"))).toBe(true);
  });
});

// ── EntityRegistry integration with new validation ──────────

describe("EntityRegistry integration with enhanced validation", () => {
  it("throws on register when schema weakens required constraint", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register({
      name: "named",
      label: "Named",
      fields: {
        display_name: { type: "string", required: true },
      },
    });

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "bad",
      implements: ["named"],
      fields: {
        display_name: { type: "string", required: false },
      },
    };

    expect(() => entityRegistry.register(schema)).toThrow("required");
  });

  it("throws on register when schema enum is missing interface-required values", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register({
      name: "prioritizable",
      label: "Prioritizable",
      fields: {
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
    });

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "task",
      implements: ["prioritizable"],
      fields: {
        priority: { type: "string", enum: ["low", "high"] }, // missing "medium"
      },
    };

    expect(() => entityRegistry.register(schema)).toThrow("medium");
  });

  it("throws on register when two interfaces have conflicting state machines", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register({
      name: "flow_a",
      label: "Flow A",
      fields: { x: { type: "string" } },
      state: {
        initial: "draft",
        transitions: [{ from: "draft", to: "submitted", action: "submit" }],
      },
    });
    ifaceRegistry.register({
      name: "flow_b",
      label: "Flow B",
      fields: { y: { type: "string" } },
      state: {
        initial: "new", // conflicts with flow_a's initial
        transitions: [],
      },
    });

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: EntityDefinition = {
      name: "bad",
      implements: ["flow_a", "flow_b"],
      fields: { z: { type: "string" } },
    };

    expect(() => entityRegistry.register(schema)).toThrow("conflicting initial");
  });
});

// ── Inherited fields in interface validation ──────────────────

describe("validateImplementation with inherited fields", () => {
  it("validates interface fields against resolvedFields (inherited)", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "auditable",
      label: "Auditable",
      fields: {
        audit_note: { type: "text", required: false },
      },
    });

    // Schema does NOT define audit_note directly
    const schema: EntityDefinition = {
      name: "child_schema",
      implements: ["auditable"],
      fields: {
        title: { type: "string" },
      },
    };

    // Without resolvedFields, validation succeeds (field is just missing, gets injected)
    const errors1 = registry.validateImplementation(schema);
    expect(errors1).toEqual([]);

    // With resolvedFields that include the inherited field, still valid
    const resolvedFields = {
      title: { type: "string" as const },
      audit_note: { type: "text" as const, required: false },
    };
    const errors2 = registry.validateImplementation(schema, resolvedFields);
    expect(errors2).toEqual([]);
  });

  it("detects type mismatch against inherited fields", () => {
    const registry = createInterfaceRegistry();
    registry.register({
      name: "auditable",
      label: "Auditable",
      fields: {
        audit_note: { type: "text", required: false },
      },
    });

    const schema: EntityDefinition = {
      name: "child_schema",
      implements: ["auditable"],
      fields: {
        title: { type: "string" },
      },
    };

    // Parent defines audit_note as "number" — inherited type conflict
    const resolvedFields = {
      title: { type: "string" as const },
      audit_note: { type: "number" as const, required: false },
    };
    const errors = registry.validateImplementation(schema, resolvedFields);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("number");
    expect(errors[0]).toContain("text");
  });

  it("EntityRegistry passes inherited fields to interface validation", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register({
      name: "trackable",
      label: "Trackable",
      fields: {
        tracking_id: { type: "string", required: true },
      },
    });

    const entityRegistry = createEntityRegistry();
    entityRegistry.setInterfaceRegistry(ifaceRegistry);

    // Register parent schema with the required field
    entityRegistry.register({
      name: "parent",
      fields: {
        tracking_id: { type: "string", required: true },
      },
    });

    // Child schema extends parent and implements interface, but doesn't define tracking_id itself
    const childSchema: EntityDefinition = {
      name: "child",
      extends: "parent",
      implements: ["trackable"],
      fields: {
        extra_field: { type: "string" },
      },
    };

    // Should NOT throw — tracking_id is inherited from parent
    expect(() => entityRegistry.register(childSchema)).not.toThrow();
  });
});
