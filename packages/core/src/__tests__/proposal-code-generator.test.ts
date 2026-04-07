import { beforeEach, describe, expect, it } from "bun:test";
import type {
  CodeGenerationProvider,
  ProjectContext,
  QualityGateRunner,
} from "../ai/proposal-code-generator";
import { ProposalCodeGenerator } from "../ai/proposal-code-generator";
import type { Proposal } from "../ai/proposal-engine";

// ── Test helpers ──────────────────────────────────────────

function createProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: "proposal-1",
    type: "add_rule",
    status: "approved",
    description: "Add validation rule for order amount",
    reasoning: "Detected that amount must be positive in 99% of records",
    confidence: 0.99,
    diff: {
      target: "rule",
      operation: "create",
      summary: "Create validation rule for positive amount",
      definition: {
        name: "validate_positive_amount",
        entity: "order",
        field: "amount",
        operator: "gt",
        value: 0,
      },
    },
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function createMockProvider(response: string): CodeGenerationProvider {
  return {
    generateCode: async (_prompt: string) => response,
  };
}

function createContext(): ProjectContext {
  return {
    entities: [
      { name: "order", fields: ["id", "amount", "currency", "status"] },
      { name: "customer", fields: ["id", "name", "email"] },
    ],
    actions: [
      { name: "create_order", entity: "order" },
      { name: "approve_order", entity: "order" },
    ],
    conventions: "All amounts are in cents. Use ISO currency codes.",
  };
}

// ── Tests ────────────────────────────────────────────────

describe("ProposalCodeGenerator", () => {
  describe("generate", () => {
    it("should generate code successfully with valid JSON response", async () => {
      const validResponse = JSON.stringify({
        files: {
          "src/rules/validate-amount.ts": 'import { defineRule } from "@linchkit/core";\n',
        },
      });
      const provider = createMockProvider(validResponse);
      const generator = new ProposalCodeGenerator(provider);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(Object.keys(result.files)).toHaveLength(1);
      expect(result.files["src/rules/validate-amount.ts"]).toContain("defineRule");
    });

    it("should work without quality gates", async () => {
      const validResponse = JSON.stringify({
        files: { "src/rule.ts": "export const rule = {};" },
      });
      const provider = createMockProvider(validResponse);
      const generator = new ProposalCodeGenerator(provider);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("should retry on quality gate failure", async () => {
      let callCount = 0;
      const provider: CodeGenerationProvider = {
        generateCode: async () => {
          callCount++;
          return JSON.stringify({
            files: { "src/rule.ts": callCount === 1 ? "bad code" : "good code" },
          });
        },
      };

      let gateCallCount = 0;
      const qualityGates: QualityGateRunner = {
        check: async () => {
          gateCallCount++;
          return gateCallCount === 1 ? ["Type error: missing return"] : [];
        },
      };

      const generator = new ProposalCodeGenerator(provider, qualityGates);
      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(callCount).toBe(2);
    });

    it("should fail after max retries exceeded", async () => {
      const provider = createMockProvider(
        JSON.stringify({ files: { "src/rule.ts": "bad" } }),
      );
      const qualityGates: QualityGateRunner = {
        check: async () => ["Persistent error"],
      };

      const generator = new ProposalCodeGenerator(provider, qualityGates, 2);
      const result = await generator.generate(createProposal());

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.errors).toContain("Persistent error");
      expect(Object.keys(result.files)).toHaveLength(0);
    });

    it("should retry when parse fails (unparseable output)", async () => {
      let callCount = 0;
      const provider: CodeGenerationProvider = {
        generateCode: async () => {
          callCount++;
          if (callCount === 1) return "not json at all";
          return JSON.stringify({ files: { "src/fix.ts": "fixed" } });
        },
      };

      const generator = new ProposalCodeGenerator(provider);
      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it("should fail when all attempts produce unparseable output", async () => {
      const provider = createMockProvider("totally not json");
      const generator = new ProposalCodeGenerator(provider, undefined, 2);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("Failed to parse")]),
      );
    });
  });

  describe("buildPrompt", () => {
    it("should include proposal details in the prompt", () => {
      const provider = createMockProvider("");
      const generator = new ProposalCodeGenerator(provider);
      const proposal = createProposal();

      const prompt = generator.buildPrompt(proposal);

      expect(prompt).toContain("add_rule");
      expect(prompt).toContain("Add validation rule for order amount");
      expect(prompt).toContain("validate_positive_amount");
      expect(prompt).toContain("rule");
      expect(prompt).toContain("create");
    });

    it("should include project context when provided", () => {
      const provider = createMockProvider("");
      const generator = new ProposalCodeGenerator(provider);
      const context = createContext();

      const prompt = generator.buildPrompt(createProposal(), context);

      expect(prompt).toContain("order");
      expect(prompt).toContain("customer");
      expect(prompt).toContain("create_order");
      expect(prompt).toContain("approve_order");
      expect(prompt).toContain("All amounts are in cents");
    });

    it("should include type-specific guidance for add_rule", () => {
      const provider = createMockProvider("");
      const generator = new ProposalCodeGenerator(provider);

      const prompt = generator.buildPrompt(createProposal({ type: "add_rule" }));

      expect(prompt).toContain("defineRule()");
      expect(prompt).toContain("trigger");
      expect(prompt).toContain("condition");
      expect(prompt).toContain("effect");
    });

    it("should include different guidance for different proposal types", () => {
      const provider = createMockProvider("");
      const generator = new ProposalCodeGenerator(provider);

      const rulePrompt = generator.buildPrompt(createProposal({ type: "add_rule" }));
      const automationPrompt = generator.buildPrompt(
        createProposal({ type: "add_automation" }),
      );
      const schemaPrompt = generator.buildPrompt(
        createProposal({ type: "modify_schema" }),
      );
      const defaultPrompt = generator.buildPrompt(
        createProposal({ type: "add_default" }),
      );

      expect(rulePrompt).toContain("RuleDefinition");
      expect(automationPrompt).toContain("AutomationDefinition");
      expect(schemaPrompt).toContain("EntityDefinition");
      expect(defaultPrompt).toContain("default values");
    });

    it("should include output format specification", () => {
      const provider = createMockProvider("");
      const generator = new ProposalCodeGenerator(provider);

      const prompt = generator.buildPrompt(createProposal());

      expect(prompt).toContain('"files"');
      expect(prompt).toContain("JSON");
    });
  });

  describe("parseOutput (via generate)", () => {
    it("should handle clean JSON", async () => {
      const response = JSON.stringify({
        files: { "a.ts": "content a", "b.ts": "content b" },
      });
      const provider = createMockProvider(response);
      const generator = new ProposalCodeGenerator(provider);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.files["a.ts"]).toBe("content a");
      expect(result.files["b.ts"]).toBe("content b");
    });

    it("should handle markdown-wrapped JSON", async () => {
      const response = [
        "Here is the generated code:",
        "",
        "```json",
        JSON.stringify({ files: { "src/rule.ts": "// rule code" } }),
        "```",
        "",
        "This implements the validation rule.",
      ].join("\n");

      const provider = createMockProvider(response);
      const generator = new ProposalCodeGenerator(provider);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(true);
      expect(result.files["src/rule.ts"]).toBe("// rule code");
    });

    it("should return empty for completely unparseable input", async () => {
      const provider = createMockProvider("Hello, I cannot generate code.");
      const generator = new ProposalCodeGenerator(provider, undefined, 1);

      const result = await generator.generate(createProposal());

      expect(result.success).toBe(false);
      expect(Object.keys(result.files)).toHaveLength(0);
    });
  });
});
