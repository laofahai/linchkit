import { describe, expect, it } from "bun:test";
import { createOntologyRegistry } from "../src/ontology/ontology-registry";
import { createInterfaceRegistry } from "../src/schema/schema-interface";
import { createSchemaRegistry } from "../src/schema/schema-registry";
import type { InterfaceDefinition, SchemaDefinition } from "../src/types/schema";

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

const purchaseRequestSchema: SchemaDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  implements: ["approvable"],
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number", required: true },
  },
};

const leaveRequestSchema: SchemaDefinition = {
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

      const schema: SchemaDefinition = {
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

      const schema: SchemaDefinition = {
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

      const schema: SchemaDefinition = {
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

      const schema: SchemaDefinition = {
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
      const schema: SchemaDefinition = {
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

      const schema: SchemaDefinition = {
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
      const schema: SchemaDefinition = {
        name: "test",
        fields: { x: { type: "string" } },
      };
      expect(registry.getInjectedFields(schema)).toEqual({});
    });
  });
});

// ── SchemaRegistry + InterfaceRegistry integration ───────────────

describe("SchemaRegistry with InterfaceRegistry", () => {
  it("validates interface implementation on register", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    // This should not throw — valid implementation
    schemaRegistry.register(purchaseRequestSchema);
  });

  it("throws on register when interface does not exist", () => {
    const ifaceRegistry = createInterfaceRegistry();
    // Do not register any interfaces

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "bad",
      implements: ["nonexistent"],
      fields: { x: { type: "string" } },
    };

    expect(() => schemaRegistry.register(schema)).toThrow("nonexistent");
  });

  it("throws on register when field type conflicts", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "bad",
      implements: ["approvable"],
      fields: {
        title: { type: "string" },
        status: { type: "number" }, // conflicts
      },
    };

    expect(() => schemaRegistry.register(schema)).toThrow("status");
  });

  it("injects interface fields during resolve", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);
    schemaRegistry.register(purchaseRequestSchema);

    const resolved = schemaRegistry.resolve("purchase_request");

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

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);

    const schema: SchemaDefinition = {
      name: "custom",
      implements: ["approvable"],
      fields: {
        title: { type: "string" },
        status: { type: "string", default: "custom_default" },
      },
    };
    schemaRegistry.register(schema);

    const resolved = schemaRegistry.resolve("custom");
    // Schema's own definition wins
    expect(resolved.fields.status.definition.default).toBe("custom_default");
  });

  it("injects fields from multiple interfaces", () => {
    const ifaceRegistry = createInterfaceRegistry();
    ifaceRegistry.register(approvableInterface);
    ifaceRegistry.register(archivableInterface);

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);
    schemaRegistry.register(leaveRequestSchema);

    const resolved = schemaRegistry.resolve("leave_request");

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

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.setInterfaceRegistry(ifaceRegistry);
    schemaRegistry.register(purchaseRequestSchema);
    schemaRegistry.register(leaveRequestSchema);

    expect(ifaceRegistry.implementors("approvable")).toEqual(
      expect.arrayContaining(["purchase_request", "leave_request"]),
    );
    expect(ifaceRegistry.implementors("archivable")).toEqual(["leave_request"]);
  });

  it("works without InterfaceRegistry set (backward compatible)", () => {
    const schemaRegistry = createSchemaRegistry();

    // Schema with implements but no InterfaceRegistry — should register fine
    const schema: SchemaDefinition = {
      name: "test",
      implements: ["approvable"],
      fields: { x: { type: "string" } },
    };
    schemaRegistry.register(schema);

    const resolved = schemaRegistry.resolve("test");
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

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(purchaseRequestSchema);
    schemaRegistry.register(leaveRequestSchema);

    const ontology = createOntologyRegistry({
      schemas: schemaRegistry,
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

    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(purchaseRequestSchema);
    schemaRegistry.register(leaveRequestSchema);

    const ontology = createOntologyRegistry({
      schemas: schemaRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      interfaces: ifaceRegistry,
    });

    const implementors = ontology.schemasImplementing("approvable");
    expect(implementors).toEqual(expect.arrayContaining(["purchase_request", "leave_request"]));
    expect(ontology.schemasImplementing("nonexistent")).toEqual([]);
  });

  it("works without interfaces (backward compatible)", () => {
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register({
      name: "simple",
      fields: { x: { type: "string" } },
    });

    const ontology = createOntologyRegistry({
      schemas: schemaRegistry,
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
      // No interfaces provided
    });

    const desc = ontology.describe("simple");
    expect(desc).toBeDefined();
    expect(desc?.interfaces).toEqual([]);
    expect(ontology.schemasImplementing("anything")).toEqual([]);
  });
});
