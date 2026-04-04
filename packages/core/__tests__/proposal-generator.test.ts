import { describe, expect, it } from "bun:test";
import { mockAIService } from "@linchkit/devtools";
import type { ProposalDefinition, EntityDefinition } from "../src";
import { ProposalGenerationError } from "../src/engine/proposal-generator";
import { createOntologyRegistry } from "../src/ontology/ontology-registry";
import { ActionRegistry, createProposalGenerator, createEntityRegistry } from "../src/server-entry";

// ── Test fixtures ───────────────────────────────────────

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    assignee_id: { type: "string", label: "Assignee" },
  },
};

const projectSchema: EntityDefinition = {
  name: "project",
  label: "Project",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    status: {
      type: "enum",
      label: "Status",
      options: [
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived" },
      ],
    },
  },
};

/** Canned AI response for "Add a priority field to Task schema" */
const addPriorityResponse = {
  title: "Add priority field to Task",
  description: "Add an enum priority field (low/medium/high) to the Task schema",
  capability: "task_management",
  changes: [
    {
      type: "modify",
      target: "entity",
      name: "task",
      definition: {
        name: "task",
        label: "Task",
        fields: {
          title: { type: "string", required: true, label: "Title" },
          description: { type: "text", label: "Description" },
          assignee_id: { type: "string", label: "Assignee" },
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
      diff: "Added field: priority (enum: low, medium, high)",
    },
  ],
  impact: {
    schemas: ["task"],
    actions: [],
    rules: [],
    dependents: [],
    migrationRequired: true,
  },
};

/** Canned AI response for creating a new schema */
const createProductResponse = {
  title: "Create product schema",
  description: "Create a product schema with name, price, and category",
  capability: "inventory",
  changes: [
    {
      type: "create",
      target: "entity",
      name: "product",
      definition: {
        name: "product",
        label: "Product",
        fields: {
          name: { type: "string", required: true, label: "Name" },
          price: { type: "number", required: true, label: "Price" },
          category: {
            type: "enum",
            label: "Category",
            options: [
              { value: "electronics", label: "Electronics" },
              { value: "clothing", label: "Clothing" },
            ],
          },
        },
      },
    },
  ],
  impact: {
    schemas: ["product"],
    actions: [],
    rules: [],
    dependents: [],
    migrationRequired: true,
  },
};

/** Canned AI response with invalid field type for validation testing */
const _invalidFieldResponse = {
  title: "Add invalid field",
  description: "Add a field with an invalid type",
  capability: "test",
  changes: [
    {
      type: "create",
      target: "entity",
      name: "broken",
      definition: {
        name: "broken",
        fields: {
          bad_field: { type: "foobar", label: "Bad" },
        },
      },
    },
  ],
  impact: {
    schemas: ["broken"],
    actions: [],
    rules: [],
    dependents: [],
    migrationRequired: false,
  },
};

/** Canned AI response with action referencing non-existent schema */
const _invalidActionResponse = {
  title: "Add orphan action",
  description: "Add an action referencing a non-existent schema",
  capability: "test",
  changes: [
    {
      type: "create",
      target: "action",
      name: "create_ghost",
      definition: {
        name: "create_ghost",
        entity: "ghost_schema",
        label: "Create Ghost",
        policy: { mode: "sync", transaction: true },
      },
    },
  ],
  impact: {
    schemas: [],
    actions: ["create_ghost"],
    rules: [],
    dependents: [],
    migrationRequired: false,
  },
};

// ── Helpers ──────────────────────────────────────────────

function createDeps(responses: Record<string, unknown>) {
  const ai = mockAIService(responses);
  const entityRegistry = createEntityRegistry();
  const actionRegistry = new ActionRegistry();
  return { ai, entityRegistry, actionRegistry };
}

// ── Tests ────────────────────────────────────────────────

describe("ProposalGenerator", () => {
  describe("generate()", () => {
    it("produces a valid Proposal structure with correct defaults", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal = await generator.generate({
        description: "Add a priority field to Task schema",
        targetCapability: "task_management",
      });

      // Structure checks
      expect(proposal.id).toBeTruthy();
      expect(proposal.title).toBe("Add priority field to Task");
      expect(proposal.description).toContain("priority");
      expect(proposal.status).toBe("draft");
      expect(proposal.createdAt).toBeInstanceOf(Date);
      expect(proposal.updatedAt).toBeInstanceOf(Date);
      expect(proposal.author.type).toBe("ai");
      expect(proposal.author.id).toBe("ai-proposal-generator");
      expect(proposal.capability).toBe("task_management");
    });

    it("always sets changeType to 'minor' in M1b", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal = await generator.generate({
        description: "Add a priority field to Task schema",
      });

      expect(proposal.changeType).toBe("minor");
    });

    it("populates changes array from AI response", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal = await generator.generate({
        description: "Add a priority field to Task schema",
      });

      expect(proposal.changes).toHaveLength(1);
      expect(proposal.changes[0].target).toBe("entity");
      expect(proposal.changes[0].operation).toBe("update"); // "modify" mapped to "update"
      expect(proposal.changes[0].name).toBe("task");
      expect(proposal.changes[0].diff).toContain("priority");
    });

    it("populates impact from AI response", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal = await generator.generate({
        description: "Add a priority field to Task schema",
      });

      expect(proposal.impact.schemasAffected).toEqual(["task"]);
      expect(proposal.impact.migrationRequired).toBe(true);
    });

    it("uses targetCapability from request when provided", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Create a product": createProductResponse,
      });

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal = await generator.generate({
        description: "Create a product schema",
        targetCapability: "my_custom_cap",
      });

      expect(proposal.capability).toBe("my_custom_cap");
    });

    it("calls AIService with system prompt containing schema context", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      await generator.generate({
        description: "Add a priority field to Task schema",
      });

      // Check that AIService was called
      expect(ai.callCount).toBe(1);
      const call = ai.calls[0];

      // System prompt should contain schema info
      const systemMsg = call.messages.find((m) => m.role === "system");
      expect(systemMsg).toBeTruthy();
      expect(systemMsg?.content).toContain("task");
      expect(systemMsg?.content).toContain("title");
    });

    it("includes ontology context in system prompt when OntologyRegistry is provided", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);
      entityRegistry.register(projectSchema);

      const ontologyRegistry = createOntologyRegistry({
        schemas: entityRegistry,
        actions: actionRegistry,
        rules: [],
        states: [],
        views: [],
      });

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
        ontologyRegistry,
      });

      await generator.generate({
        description: "Add a priority field to Task schema",
      });

      expect(ai.callCount).toBe(1);
      const call = ai.calls[0];
      const systemMsg = call.messages.find((m) => m.role === "system");
      expect(systemMsg).toBeTruthy();

      // Ontology markdown includes the "# Ontology" header and "## Fields" sections
      expect(systemMsg?.content).toContain("Ontology");
      // Should contain both schema names from ontology
      expect(systemMsg?.content).toContain("Task");
      expect(systemMsg?.content).toContain("Project");
      // Should contain field details from ontology markdown
      expect(systemMsg?.content).toContain("title");
      expect(systemMsg?.content).toContain("name");
    });

    it("throws ProposalGenerationError when AI service is not configured", async () => {
      const entityRegistry = createEntityRegistry();
      const actionRegistry = new ActionRegistry();

      // Create an AI service that throws "not configured"
      const noopAI = {
        configured: false,
        defaultProvider: null,
        providerNames: [],
        complete: () => {
          throw new Error(
            "AI service is not configured. Add an 'ai' section to your LinchKit config.",
          );
        },
      };

      const generator = createProposalGenerator({
        aiService: noopAI,
        entityRegistry,
        actionRegistry,
      });

      try {
        await generator.generate({ description: "Add a field" });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ProposalGenerationError);
        expect((err as ProposalGenerationError).message).toContain("not configured");
        expect((err as ProposalGenerationError).cause).toBeTruthy();
      }
    });

    it("throws ProposalGenerationError with descriptive message on generic AI failure", async () => {
      const entityRegistry = createEntityRegistry();
      const actionRegistry = new ActionRegistry();

      const failingAI = {
        configured: true,
        defaultProvider: "mock",
        providerNames: ["mock"],
        complete: () => {
          throw new Error("Rate limit exceeded");
        },
      };

      const generator = createProposalGenerator({
        aiService: failingAI,
        entityRegistry,
        actionRegistry,
      });

      try {
        await generator.generate({ description: "Add a field" });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ProposalGenerationError);
        expect((err as ProposalGenerationError).message).toContain("Rate limit exceeded");
        expect((err as ProposalGenerationError).message).toContain("AI proposal generation failed");
      }
    });

    it("includes example proposal in system prompt", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a priority field": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      await generator.generate({
        description: "Add a priority field to Task schema",
      });

      const call = ai.calls[0];
      const systemMsg = call.messages.find((m) => m.role === "system");
      // System prompt should contain the example
      expect(systemMsg?.content).toContain("Example proposal");
    });

    it("includes additional context in user message", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({
        "Add a deadline": addPriorityResponse,
      });
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      await generator.generate({
        description: "Add a deadline field to Task",
        context: { fieldType: "datetime", required: true },
      });

      const call = ai.calls[0];
      const userMsg = call.messages.find((m) => m.role === "user");
      expect(userMsg?.content).toContain("Additional context");
      expect(userMsg?.content).toContain("datetime");
    });
  });

  describe("validate()", () => {
    it("passes validation for valid schema changes", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      // Build a valid proposal manually
      const proposal: ProposalDefinition = {
        id: "test-1",
        title: "Update task",
        description: "Update task schema",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "update",
            name: "task",
            definition: {
              name: "task",
              label: "Task",
              fields: {
                title: { type: "string", required: true, label: "Title" },
                priority: {
                  type: "enum",
                  label: "Priority",
                  options: [{ value: "low", label: "Low" }],
                },
              },
            },
          },
        ],
        impact: {
          schemasAffected: ["task"],
          actionsAffected: [],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: false,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.passed).toBe(true);
      expect(result.phases[0].status).toBe("passed");
      expect(result.phases[0].errors).toHaveLength(0);
    });

    it("catches invalid field types", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal: ProposalDefinition = {
        id: "test-2",
        title: "Bad schema",
        description: "Schema with invalid field type",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "create",
            name: "broken",
            definition: {
              name: "broken",
              fields: {
                bad_field: { type: "foobar" as never, label: "Bad" },
              },
            } as never,
          },
        ],
        impact: {
          schemasAffected: ["broken"],
          actionsAffected: [],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: false,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.passed).toBe(false);
      expect(result.phases[0].errors.length).toBeGreaterThan(0);
      expect(result.phases[0].errors[0].message).toContain("foobar");
    });

    it("catches missing schema reference in action", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal: ProposalDefinition = {
        id: "test-3",
        title: "Orphan action",
        description: "Action with missing schema",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "action",
            operation: "create",
            name: "create_ghost",
            definition: {
              name: "create_ghost",
              entity: "ghost_schema",
              label: "Create Ghost",
              policy: { mode: "sync", transaction: true },
            } as never,
          },
        ],
        impact: {
          schemasAffected: [],
          actionsAffected: ["create_ghost"],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: false,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.passed).toBe(false);
      expect(result.phases[0].errors.some((e) => e.message.includes("ghost_schema"))).toBe(true);
    });

    it("catches enum field without options", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal: ProposalDefinition = {
        id: "test-5",
        title: "Enum without options",
        description: "Schema with enum field missing options",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "create",
            name: "bad_enum",
            definition: {
              name: "bad_enum",
              fields: {
                status: { type: "enum", label: "Status" },
              },
            } as never,
          },
        ],
        impact: {
          schemasAffected: ["bad_enum"],
          actionsAffected: [],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: false,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.passed).toBe(false);
      expect(
        result.phases[0].errors.some((e) => e.message.includes("enum field must have options")),
      ).toBe(true);
    });

    it("warns on duplicate schema create", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal: ProposalDefinition = {
        id: "test-6",
        title: "Duplicate schema",
        description: "Create schema that already exists",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "create",
            name: "task",
            definition: taskSchema,
          },
        ],
        impact: {
          schemasAffected: ["task"],
          actionsAffected: [],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: false,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.passed).toBe(false);
      expect(result.phases[0].errors.some((e) => e.message.includes("already exists"))).toBe(true);
    });

    it("builds impact summary string", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});
      entityRegistry.register(taskSchema);

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      const proposal: ProposalDefinition = {
        id: "test-7",
        title: "Test impact",
        description: "Test",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "test",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "update",
            name: "task",
            definition: {
              name: "task",
              label: "Task",
              fields: {
                title: { type: "string", required: true, label: "Title" },
              },
            },
          },
        ],
        impact: {
          schemasAffected: ["task"],
          actionsAffected: ["create_task"],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: true,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      expect(result.impactSummary).toContain("task");
      expect(result.impactSummary).toContain("create_task");
      expect(result.impactSummary).toContain("migration");
    });

    it("validates action with schema created in same proposal", async () => {
      const { ai, entityRegistry, actionRegistry } = createDeps({});

      const generator = createProposalGenerator({
        aiService: ai,
        entityRegistry,
        actionRegistry,
      });

      // Proposal creates a schema and an action referencing it
      const proposal: ProposalDefinition = {
        id: "test-8",
        title: "Create invoice module",
        description: "Create invoice schema with create action",
        author: { type: "ai", id: "ai", name: "AI" },
        capability: "billing",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "create",
            name: "invoice",
            definition: {
              name: "invoice",
              label: "Invoice",
              fields: {
                amount: { type: "number", required: true, label: "Amount" },
              },
            },
          },
          {
            target: "action",
            operation: "create",
            name: "create_invoice",
            definition: {
              name: "create_invoice",
              entity: "invoice",
              label: "Create Invoice",
              policy: { mode: "sync", transaction: true },
            } as never,
          },
        ],
        impact: {
          schemasAffected: ["invoice"],
          actionsAffected: ["create_invoice"],
          rulesAffected: [],
          dependentsAffected: [],
          migrationRequired: true,
        },
        status: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await generator.validate(proposal);
      // Action references "invoice" which is created in the same proposal — should pass
      expect(result.passed).toBe(true);
    });
  });
});
