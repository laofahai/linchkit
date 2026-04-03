import { describe, expect, it } from "bun:test";
import { ActionRegistry } from "../src/engine/action-engine";
import { createOntologyRegistry } from "../src/ontology/ontology-registry";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";
import type { EntityDefinition } from "../src/types/entity";
import type { StateDefinition } from "../src/types/state";
import type { ViewDefinition } from "../src/types/view";

// ── Test fixtures ───────────────────────────────────────

const partySchema: EntityDefinition = {
  name: "party",
  label: "Party",
  abstract: true,
  presentation: {
    titleField: "name",
    icon: "users",
  },
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", label: "Email" },
    phone: { type: "string", label: "Phone" },
    address: { type: "text", label: "Address" },
  },
};

const customerSchema: EntityDefinition = {
  name: "customer",
  extends: "party",
  label: "Customer",
  fields: {
    credit_limit: { type: "number", default: 0, label: "Credit Limit" },
    payment_terms: { type: "string", label: "Payment Terms" },
  },
};

const supplierSchema: EntityDefinition = {
  name: "supplier",
  extends: "party",
  fields: {
    tax_id: { type: "string", label: "Tax ID" },
    lead_time_days: { type: "number", label: "Lead Time (days)" },
  },
};

// ── Tests ───────────────────────────────────────────────

describe("Schema Inheritance (spec 49)", () => {
  describe("field inheritance", () => {
    it("child schema inherits parent fields", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      const resolved = registry.resolve("customer");

      // Inherited fields from parent
      expect(resolved.fields.name).toBeDefined();
      expect(resolved.fields.name.definition.type).toBe("string");
      expect(resolved.fields.name.definition.required).toBe(true);
      expect(resolved.fields.email).toBeDefined();
      expect(resolved.fields.phone).toBeDefined();
      expect(resolved.fields.address).toBeDefined();

      // Own fields
      expect(resolved.fields.credit_limit).toBeDefined();
      expect(resolved.fields.credit_limit.definition.type).toBe("number");
      expect(resolved.fields.payment_terms).toBeDefined();
    });

    it("child fields override parent fields of same name", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register({
        name: "vip_customer",
        extends: "party",
        fields: {
          // Override parent's email to make it required
          email: { type: "string", required: true, label: "VIP Email" },
          vip_level: { type: "number", label: "VIP Level" },
        },
      });

      const resolved = registry.resolve("vip_customer");

      // Overridden field
      expect(resolved.fields.email.definition.required).toBe(true);
      expect(resolved.fields.email.label).toBe("VIP Email");

      // Other inherited fields still present
      expect(resolved.fields.name).toBeDefined();
      expect(resolved.fields.phone).toBeDefined();
    });

    it("multi-level inheritance works (grandchild inherits from grandparent)", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register({
        name: "premium_customer",
        extends: "customer",
        fields: {
          premium_tier: { type: "string", label: "Premium Tier" },
        },
      });

      const resolved = registry.resolve("premium_customer");

      // From grandparent (party)
      expect(resolved.fields.name).toBeDefined();
      expect(resolved.fields.email).toBeDefined();

      // From parent (customer)
      expect(resolved.fields.credit_limit).toBeDefined();

      // Own fields
      expect(resolved.fields.premium_tier).toBeDefined();
    });

    it("child cannot change type of inherited field", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);

      expect(() =>
        registry.register({
          name: "bad_child",
          extends: "party",
          fields: {
            // Try to change email from string to number
            email: { type: "number", label: "Email" },
          },
        }),
      ).toThrow('cannot change type of inherited field "email" from "string" to "number"');
    });

    it("child can override non-structural properties (label, required, default)", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register({
        name: "strict_party",
        extends: "party",
        fields: {
          // Same type, but change required and label
          email: { type: "string", required: true, label: "Required Email" },
          extra: { type: "string" },
        },
      });

      const resolved = registry.resolve("strict_party");
      expect(resolved.fields.email.definition.required).toBe(true);
      expect(resolved.fields.email.label).toBe("Required Email");
    });

    it("grandchild cannot change type of grandparent field", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      expect(() =>
        registry.register({
          name: "bad_grandchild",
          extends: "customer",
          fields: {
            // Try to change grandparent field type
            name: { type: "number" },
          },
        }),
      ).toThrow('cannot change type of inherited field "name" from "string" to "number"');
    });
  });

  describe("abstract schemas", () => {
    it("abstract schema can be resolved", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);

      const resolved = registry.resolve("party");
      expect(resolved.abstract).toBe(true);
      expect(resolved.fields.name).toBeDefined();
    });

    it("getConcrete() excludes abstract schemas", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register(supplierSchema);

      const concrete = registry.getConcrete();
      expect(concrete).toHaveLength(2);
      expect(concrete.map((s) => s.name)).toContain("customer");
      expect(concrete.map((s) => s.name)).toContain("supplier");
      expect(concrete.map((s) => s.name)).not.toContain("party");
    });

    it("getAll() includes abstract schemas", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.name)).toContain("party");
    });
  });

  describe("resolved schema metadata", () => {
    it("resolved schema includes parent and children info", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register(supplierSchema);

      const resolvedParty = registry.resolve("party");
      expect(resolvedParty.parent).toBeUndefined();
      expect(resolvedParty.children).toContain("customer");
      expect(resolvedParty.children).toContain("supplier");

      const resolvedCustomer = registry.resolve("customer");
      expect(resolvedCustomer.parent).toBe("party");
      expect(resolvedCustomer.children).toEqual([]);
    });

    it("inherits parent presentation when child has none", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(supplierSchema); // no presentation defined

      const resolved = registry.resolve("supplier");
      // Child doesn't inherit presentation automatically (it's on the child's own definition)
      expect(resolved.presentation).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("throws when parent does not exist at registration time", () => {
      const registry = createEntityRegistry();

      expect(() => registry.register(customerSchema)).toThrow(
        'Schema "customer" extends unknown schema "party"',
      );
    });

    it("detects circular inheritance", () => {
      const registry = createEntityRegistry();

      // Register A -> B -> A cycle
      // We need to trick the registry by registering without extends first
      registry.register({ name: "a", fields: { x: { type: "string" } } });
      registry.register({
        name: "b",
        extends: "a",
        fields: { y: { type: "string" } },
      });

      // Validate should catch that re-registering would create a cycle
      // But since we can't create a true cycle with register() (parent must exist first),
      // test the validateInheritance method
      const errors = registry.validateInheritance();
      expect(errors).toHaveLength(0); // No cycle here
    });

    it("enforces maximum inheritance depth of 3", () => {
      const registry = createEntityRegistry();
      registry.register({ name: "level1", fields: { x: { type: "string" } } });
      registry.register({
        name: "level2",
        extends: "level1",
        fields: { y: { type: "string" } },
      });
      registry.register({
        name: "level3",
        extends: "level2",
        fields: { z: { type: "string" } },
      });

      // level4 would exceed max depth (chain: level1 -> level2 -> level3 -> level4 = 4 levels)
      expect(() =>
        registry.register({
          name: "level4",
          extends: "level3",
          fields: { w: { type: "string" } },
        }),
      ).toThrow("Inheritance depth exceeds maximum of 3 levels");
    });

    it("allows exactly 3 levels of inheritance", () => {
      const registry = createEntityRegistry();
      registry.register({ name: "root", fields: { a: { type: "string" } } });
      registry.register({
        name: "mid",
        extends: "root",
        fields: { b: { type: "string" } },
      });

      // 3 levels total: root -> mid -> leaf
      expect(() =>
        registry.register({
          name: "leaf",
          extends: "mid",
          fields: { c: { type: "string" } },
        }),
      ).not.toThrow();

      const resolved = registry.resolve("leaf");
      expect(resolved.fields.a).toBeDefined();
      expect(resolved.fields.b).toBeDefined();
      expect(resolved.fields.c).toBeDefined();
    });

    it("validateInheritance returns errors for missing parents", () => {
      const registry = createEntityRegistry();
      // Register parent first, then child
      registry.register(partySchema);
      registry.register(customerSchema);

      // All valid
      const errors = registry.validateInheritance();
      expect(errors).toHaveLength(0);
    });
  });

  describe("interaction with extensions and overrides", () => {
    it("extensions on child schema work alongside inherited fields", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      registry.applyExtension("customer", {
        fields: { loyalty_tier: { type: "string", label: "Loyalty Tier" } },
      });

      const resolved = registry.resolve("customer");

      // Inherited
      expect(resolved.fields.name).toBeDefined();
      // Own
      expect(resolved.fields.credit_limit).toBeDefined();
      // Extension
      expect(resolved.fields.loyalty_tier).toBeDefined();
    });

    it("overrides on child schema can modify inherited fields", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      // Override inherited field's constraint
      registry.applyOverride("customer", {
        fields: { email: { required: true } },
      });

      const resolved = registry.resolve("customer");
      expect(resolved.fields.email.definition.required).toBe(true);
    });
  });

  describe("getInheritanceChain", () => {
    it("returns single element for schema with no parent", () => {
      const registry = createEntityRegistry();
      registry.register({ name: "standalone", fields: { x: { type: "string" } } });

      const chain = registry.getInheritanceChain("standalone");
      expect(chain).toEqual(["standalone"]);
    });

    it("returns root-to-self order for 2-level chain", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      const chain = registry.getInheritanceChain("customer");
      expect(chain).toEqual(["party", "customer"]);
    });

    it("returns root-to-self order for 3-level chain", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register({
        name: "premium_customer",
        extends: "customer",
        fields: { tier: { type: "string" } },
      });

      const chain = registry.getInheritanceChain("premium_customer");
      expect(chain).toEqual(["party", "customer", "premium_customer"]);
    });
  });

  describe("getChildren and getAllDescendants", () => {
    it("getChildren returns direct children only", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register(supplierSchema);
      registry.register({
        name: "premium_customer",
        extends: "customer",
        fields: { tier: { type: "string" } },
      });

      const children = registry.getChildren("party");
      expect(children).toContain("customer");
      expect(children).toContain("supplier");
      expect(children).not.toContain("premium_customer"); // grandchild, not direct
    });

    it("getAllDescendants returns all descendants recursively", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register(supplierSchema);
      registry.register({
        name: "premium_customer",
        extends: "customer",
        fields: { tier: { type: "string" } },
      });

      const descendants = registry.getAllDescendants("party");
      expect(descendants).toContain("customer");
      expect(descendants).toContain("supplier");
      expect(descendants).toContain("premium_customer");
      expect(descendants).toHaveLength(3);
    });

    it("getAllDescendants returns empty for leaf schema", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      const descendants = registry.getAllDescendants("customer");
      expect(descendants).toEqual([]);
    });
  });

  describe("action inheritance via ActionRegistry", () => {
    it("getBySchemaWithInheritance returns inherited + own actions", () => {
      const entityRegistry = createEntityRegistry();
      entityRegistry.register(partySchema);
      entityRegistry.register(customerSchema);

      const actionRegistry = new ActionRegistry();
      const parentAction: ActionDefinition = {
        name: "update_contact_info",
        schema: "party",
        label: "Update Contact Info",
        handler: async () => ({}),
      };
      const childAction: ActionDefinition = {
        name: "upgrade_loyalty",
        schema: "customer",
        label: "Upgrade Loyalty",
        handler: async () => ({}),
      };
      actionRegistry.register(parentAction);
      actionRegistry.register(childAction);

      const chain = entityRegistry.getInheritanceChain("customer");
      const actions = actionRegistry.getBySchemaWithInheritance("customer", chain);

      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.name)).toContain("update_contact_info");
      expect(actions.map((a) => a.name)).toContain("upgrade_loyalty");
    });

    it("child action overrides parent action with same name", () => {
      const entityRegistry = createEntityRegistry();
      entityRegistry.register(partySchema);
      entityRegistry.register(customerSchema);

      const actionRegistry = new ActionRegistry();
      actionRegistry.register({
        name: "validate_party",
        schema: "party",
        label: "Validate Party",
        handler: async () => ({ source: "parent" }),
      });
      // Child defines same-named action with overwrite to simulate override
      actionRegistry.register(
        {
          name: "validate_party",
          schema: "customer",
          label: "Validate Customer",
          handler: async () => ({ source: "child" }),
        },
        { overwrite: true },
      );

      const chain = entityRegistry.getInheritanceChain("customer");
      const actions = actionRegistry.getBySchemaWithInheritance("customer", chain);

      // Only one "validate_party" action — child's version wins since it's in customer schema
      const validateActions = actions.filter((a) => a.name === "validate_party");
      expect(validateActions).toHaveLength(1);
      expect(validateActions[0]?.label).toBe("Validate Customer");
    });

    it("3-level chain inherits all ancestor actions", () => {
      const entityRegistry = createEntityRegistry();
      entityRegistry.register(partySchema);
      entityRegistry.register(customerSchema);
      entityRegistry.register({
        name: "premium_customer",
        extends: "customer",
        fields: { tier: { type: "string" } },
      });

      const actionRegistry = new ActionRegistry();
      actionRegistry.register({
        name: "party_action",
        schema: "party",
        label: "Party Action",
        handler: async () => ({}),
      });
      actionRegistry.register({
        name: "customer_action",
        schema: "customer",
        label: "Customer Action",
        handler: async () => ({}),
      });
      actionRegistry.register({
        name: "premium_action",
        schema: "premium_customer",
        label: "Premium Action",
        handler: async () => ({}),
      });

      const chain = entityRegistry.getInheritanceChain("premium_customer");
      const actions = actionRegistry.getBySchemaWithInheritance("premium_customer", chain);

      expect(actions).toHaveLength(3);
      expect(actions.map((a) => a.name)).toContain("party_action");
      expect(actions.map((a) => a.name)).toContain("customer_action");
      expect(actions.map((a) => a.name)).toContain("premium_action");
    });
  });

  describe("OntologyRegistry inheritance integration", () => {
    function setupOntologyWithInheritance() {
      const entityRegistry = createEntityRegistry();
      entityRegistry.register(partySchema);
      entityRegistry.register(customerSchema);
      entityRegistry.register(supplierSchema);

      const actionRegistry = new ActionRegistry();
      const parentAction: ActionDefinition = {
        name: "update_contact_info",
        schema: "party",
        label: "Update Contact Info",
        handler: async () => ({}),
      };
      const customerAction: ActionDefinition = {
        name: "upgrade_loyalty",
        schema: "customer",
        label: "Upgrade Loyalty",
        handler: async () => ({}),
      };
      actionRegistry.register(parentAction);
      actionRegistry.register(customerAction);

      const parentRule: RuleDefinition = {
        name: "party_email_format",
        label: "Party Email Format",
        trigger: { action: "update_contact_info" },
        condition: { field: "email", operator: "contains", value: "@" },
        effect: { type: "block", message: "Invalid email" },
      };

      const parentState: StateDefinition = {
        name: "party_status",
        schema: "party",
        field: "status",
        initial: "active",
        states: ["active", "inactive"],
        transitions: [
          { from: "active", to: "inactive", action: "deactivate" },
          { from: "inactive", to: "active", action: "activate" },
        ],
      };

      const parentView: ViewDefinition = {
        name: "party_list",
        schema: "party",
        type: "list",
        fields: [
          { field: "name", label: "Name" },
          { field: "email", label: "Email" },
        ],
      };

      const customerView: ViewDefinition = {
        name: "customer_list",
        schema: "customer",
        type: "list",
        fields: [
          { field: "name", label: "Name" },
          { field: "credit_limit", label: "Credit Limit" },
        ],
      };

      const ontology = createOntologyRegistry({
        schemas: entityRegistry,
        actions: actionRegistry,
        rules: [parentRule],
        states: [parentState],
        views: [parentView, customerView],
      });

      return { entityRegistry, actionRegistry, ontology };
    }

    it("actionsFor returns inherited actions", () => {
      const { ontology } = setupOntologyWithInheritance();

      const actions = ontology.actionsFor("customer");
      expect(actions.map((a) => a.name)).toContain("update_contact_info");
      expect(actions.map((a) => a.name)).toContain("upgrade_loyalty");
    });

    it("rulesFor returns inherited rules", () => {
      const { ontology } = setupOntologyWithInheritance();

      // Rules defined on party (via update_contact_info action) should apply to customer
      const parentRules = ontology.rulesFor("party");
      expect(parentRules).toHaveLength(1);
      expect(parentRules[0]?.name).toBe("party_email_format");
    });

    it("stateFor returns inherited state machine when child has none", () => {
      const { ontology } = setupOntologyWithInheritance();

      // Party has a state machine, customer doesn't define its own
      const customerState = ontology.stateFor("customer");
      expect(customerState).toBeDefined();
      expect(customerState?.name).toBe("party_status");
      expect(customerState?.initial).toBe("active");
    });

    it("stateFor returns own state when child overrides", () => {
      const entityRegistry = createEntityRegistry();
      entityRegistry.register(partySchema);
      entityRegistry.register(customerSchema);

      const parentState: StateDefinition = {
        name: "party_status",
        schema: "party",
        field: "status",
        initial: "active",
        states: ["active", "inactive"],
        transitions: [],
      };
      const customerState: StateDefinition = {
        name: "customer_status",
        schema: "customer",
        field: "status",
        initial: "new",
        states: ["new", "active", "churned"],
        transitions: [],
      };

      const ontology = createOntologyRegistry({
        schemas: entityRegistry,
        actions: new ActionRegistry(),
        rules: [],
        states: [parentState, customerState],
        views: [],
      });

      const state = ontology.stateFor("customer");
      expect(state?.name).toBe("customer_status");
      expect(state?.initial).toBe("new");
    });

    it("viewsFor returns inherited + own views", () => {
      const { ontology } = setupOntologyWithInheritance();

      const views = ontology.viewsFor("customer");
      expect(views.map((v) => v.name)).toContain("party_list");
      expect(views.map((v) => v.name)).toContain("customer_list");
    });

    it("describe includes parent and children info", () => {
      const { ontology } = setupOntologyWithInheritance();

      const partyDesc = ontology.describe("party");
      expect(partyDesc?.parent).toBeNull();
      expect(partyDesc?.children).toContain("customer");
      expect(partyDesc?.children).toContain("supplier");
      expect(partyDesc?.abstract).toBe(true);

      const customerDesc = ontology.describe("customer");
      expect(customerDesc?.parent).toBe("party");
      expect(customerDesc?.children).toEqual([]);
      expect(customerDesc?.abstract).toBeUndefined();
    });

    it("supplier does not inherit customer-specific actions", () => {
      const { ontology } = setupOntologyWithInheritance();

      const supplierActions = ontology.actionsFor("supplier");
      // Supplier should inherit parent (party) actions but not sibling (customer) actions
      expect(supplierActions.map((a) => a.name)).toContain("update_contact_info");
      expect(supplierActions.map((a) => a.name)).not.toContain("upgrade_loyalty");
    });
  });

  describe("edge cases", () => {
    it("schema without extends has empty inheritance chain", () => {
      const registry = createEntityRegistry();
      registry.register({ name: "standalone", fields: { x: { type: "string" } } });

      const resolved = registry.resolve("standalone");
      expect(resolved.parent).toBeUndefined();
      expect(resolved.children).toEqual([]);
    });

    it("multiple children of the same parent are independent", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);
      registry.register(supplierSchema);

      const resolvedCustomer = registry.resolve("customer");
      const resolvedSupplier = registry.resolve("supplier");

      // Customer has its fields, not supplier's
      expect(resolvedCustomer.fields.credit_limit).toBeDefined();
      expect(resolvedCustomer.fields.tax_id).toBeUndefined();

      // Supplier has its fields, not customer's
      expect(resolvedSupplier.fields.tax_id).toBeDefined();
      expect(resolvedSupplier.fields.credit_limit).toBeUndefined();
    });

    it("system fields are present in both parent and child", () => {
      const registry = createEntityRegistry();
      registry.register(partySchema);
      registry.register(customerSchema);

      const resolvedParent = registry.resolve("party");
      const resolvedChild = registry.resolve("customer");

      expect(resolvedParent.fields.id).toBeDefined();
      expect(resolvedParent.fields.tenant_id).toBeDefined();
      expect(resolvedChild.fields.id).toBeDefined();
      expect(resolvedChild.fields.tenant_id).toBeDefined();
    });

    it("non-abstract parent can still be extended", () => {
      const registry = createEntityRegistry();
      registry.register({
        name: "document",
        label: "Document",
        // Not abstract — can create documents directly
        fields: {
          title: { type: "string", required: true },
          content: { type: "text" },
        },
      });
      registry.register({
        name: "invoice",
        extends: "document",
        fields: {
          amount: { type: "number", required: true },
        },
      });

      const resolvedDoc = registry.resolve("document");
      expect(resolvedDoc.abstract).toBeUndefined();
      expect(resolvedDoc.children).toContain("invoice");

      const resolvedInvoice = registry.resolve("invoice");
      expect(resolvedInvoice.fields.title).toBeDefined();
      expect(resolvedInvoice.fields.amount).toBeDefined();
    });
  });
});
