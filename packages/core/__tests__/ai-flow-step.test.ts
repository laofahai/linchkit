/**
 * Tests for AI step execution in SyncFlowEngine
 *
 * Verifies:
 * - Basic AI step execution (prompt → response stored in context)
 * - Prompt template variable resolution ($prev, $steps, $input)
 * - Tool call handling (AI requests tool calls → actions executed → results fed back)
 * - Multi-round tool call loop with max round limit
 * - Error handling in tool calls
 * - AI step in parallel step context
 */

import { describe, expect, it } from "bun:test";
import { createSyncFlowEngine } from "../src/flow/sync-engine";
import type { FlowStepContext } from "../src/flow/types";
import type { FlowDefinition } from "../src/types/flow";

// ── Mock step context with AI support ────────────────────

interface MockCallAIResult {
  response: string;
  tokensUsed: number;
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
}

function createAIStepContext(options?: {
  actions?: Record<string, (input: Record<string, unknown>) => Record<string, unknown>>;
  aiResponses?: Array<MockCallAIResult>;
}): FlowStepContext & {
  aiCalls: Array<{ prompt: string }>;
  actionCalls: Array<{ name: string; input: Record<string, unknown> }>;
} {
  const aiCalls: Array<{ prompt: string }> = [];
  const actionCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let aiCallIndex = 0;
  const aiResponses = options?.aiResponses ?? [{ response: "default AI response", tokensUsed: 30 }];

  return {
    flowContext: {},
    aiCalls,
    actionCalls,

    async executeAction(actionName, input) {
      actionCalls.push({ name: actionName, input });
      const handler = options?.actions?.[actionName];
      if (handler) return handler(input);
      return { success: true, actionName };
    },

    async callAI(opts) {
      aiCalls.push({ prompt: opts.prompt });
      const idx = Math.min(aiCallIndex, aiResponses.length - 1);
      aiCallIndex++;
      const resp = aiResponses[idx];
      return resp ?? { response: "default AI response", tokensUsed: 30 };
    },

    evaluateCondition(expression) {
      return expression === "true";
    },
  };
}

// ── Test fixtures ────────────────────────────────────────

const simpleAIFlow: FlowDefinition = {
  name: "simple-ai-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "ai-step",
      name: "AI Analysis",
      type: "ai",
      prompt: "Analyze this data",
      model: "fast",
    },
  ],
};

const aiWithTemplateFlow: FlowDefinition = {
  name: "ai-template-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "create",
      name: "Create Record",
      type: "action",
      actionName: "record.create",
      input: { title: "Test" },
    },
    {
      id: "ai-analyze",
      name: "AI Analyze",
      type: "ai",
      prompt: {
        template: "Analyze record with title {title} from previous step",
        variables: { title: "$prev.output.title" },
      },
    },
  ],
};

const aiWithExpressionPromptFlow: FlowDefinition = {
  name: "ai-expr-prompt-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "create",
      name: "Create Record",
      type: "action",
      actionName: "record.create",
      input: { title: "Test Record" },
    },
    {
      id: "ai-step",
      name: "AI Step",
      type: "ai",
      prompt: "Process the record: $prev.output.title",
    },
  ],
};

const aiAfterConditionFlow: FlowDefinition = {
  name: "ai-after-condition",
  trigger: { type: "manual" },
  steps: [
    {
      id: "check",
      name: "Check",
      type: "condition",
      expression: "true",
      // biome-ignore lint/suspicious/noThenProperty: flow condition step definition
      then: "ai-step",
    },
    {
      id: "ai-step",
      name: "AI Step",
      type: "ai",
      prompt: "Do analysis",
    },
    {
      id: "final",
      name: "Final",
      type: "action",
      actionName: "final.action",
    },
  ],
};

const aiWithToolsFlow: FlowDefinition = {
  name: "ai-tools-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "ai-with-tools",
      name: "AI with Tools",
      type: "ai",
      prompt: "Find and process the order",
      tools: ["order.find", "order.process"],
    },
  ],
};

// ── Tests ────────────────────────────────────────────────

describe("AI Flow Step Execution", () => {
  describe("basic AI step", () => {
    it("executes a simple AI step and stores response in context", async () => {
      const ctx = createAIStepContext({
        aiResponses: [{ response: "Analysis complete: all good", tokensUsed: 50 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(simpleAIFlow);

      const instance = await engine.startFlow("simple-ai-flow", { data: "test" });

      expect(instance.status).toBe("completed");

      // Verify AI was called
      expect(ctx.aiCalls).toHaveLength(1);
      expect(ctx.aiCalls[0].prompt).toBe("Analyze this data");

      // Verify result is stored in flow context
      const steps = instance.context.__steps as Record<string, { output: unknown }>;
      const aiOutput = steps["ai-step"]?.output as Record<string, unknown>;
      expect(aiOutput.response).toBe("Analysis complete: all good");
      expect(aiOutput.tokensUsed).toBe(50);
    });

    it("stores AI response as previous step output for downstream steps", async () => {
      const flow: FlowDefinition = {
        name: "ai-then-action",
        trigger: { type: "manual" },
        steps: [
          {
            id: "ai-step",
            name: "AI Step",
            type: "ai",
            prompt: "Generate recommendation",
          },
          {
            id: "action-step",
            name: "Action Step",
            type: "action",
            actionName: "apply.recommendation",
            input: { recommendation: "$prev.output.response" },
          },
        ],
      };

      const ctx = createAIStepContext({
        aiResponses: [{ response: "Recommend option A", tokensUsed: 25 }],
        actions: {
          "apply.recommendation": (input) => ({
            applied: true,
            recommendation: input.recommendation,
          }),
        },
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("ai-then-action", {});

      expect(instance.status).toBe("completed");
      expect(ctx.actionCalls).toHaveLength(1);
      expect(ctx.actionCalls[0].input.recommendation).toBe("Recommend option A");
    });
  });

  describe("prompt template resolution", () => {
    it("resolves template variables from previous step output", async () => {
      const ctx = createAIStepContext({
        actions: {
          "record.create": () => ({ title: "Created Title", id: "r-1" }),
        },
        aiResponses: [{ response: "Analyzed", tokensUsed: 20 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithTemplateFlow);

      const instance = await engine.startFlow("ai-template-flow", {});

      expect(instance.status).toBe("completed");
      expect(ctx.aiCalls).toHaveLength(1);
      expect(ctx.aiCalls[0].prompt).toBe(
        "Analyze record with title Created Title from previous step",
      );
    });

    it("resolves $-expression in plain string prompt", async () => {
      const ctx = createAIStepContext({
        actions: {
          "record.create": () => ({ title: "My Record", id: "r-2" }),
        },
        aiResponses: [{ response: "Processed", tokensUsed: 15 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithExpressionPromptFlow);

      const instance = await engine.startFlow("ai-expr-prompt-flow", {});

      expect(instance.status).toBe("completed");
      expect(ctx.aiCalls).toHaveLength(1);
      expect(ctx.aiCalls[0].prompt).toBe("Process the record: My Record");
    });

    it("resolves $input expressions in prompt", async () => {
      const flow: FlowDefinition = {
        name: "ai-input-ref",
        trigger: { type: "manual" },
        steps: [
          {
            id: "ai-step",
            name: "AI Step",
            type: "ai",
            prompt: "Process user $input.userName with role $input.role",
          },
        ],
      };

      const ctx = createAIStepContext({
        aiResponses: [{ response: "Done", tokensUsed: 10 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      await engine.startFlow("ai-input-ref", { userName: "Alice", role: "admin" });

      expect(ctx.aiCalls[0].prompt).toBe("Process user Alice with role admin");
    });

    it("resolves $steps.{id} expressions in prompt", async () => {
      const flow: FlowDefinition = {
        name: "ai-steps-ref",
        trigger: { type: "manual" },
        steps: [
          {
            id: "step1",
            name: "First",
            type: "action",
            actionName: "first.action",
          },
          {
            id: "ai-step",
            name: "AI Step",
            type: "ai",
            prompt: "Analyze: $steps.step1.output.result",
          },
        ],
      };

      const ctx = createAIStepContext({
        actions: {
          "first.action": () => ({ result: "step1-data" }),
        },
        aiResponses: [{ response: "Analyzed", tokensUsed: 10 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      await engine.startFlow("ai-steps-ref", {});

      expect(ctx.aiCalls[0].prompt).toBe("Analyze: step1-data");
    });
  });

  describe("tool call handling", () => {
    it("executes tool calls and feeds results back to AI", async () => {
      const ctx = createAIStepContext({
        actions: {
          "order.find": (input) => ({ id: "ord-1", amount: 500, query: input.query }),
          "order.process": (input) => ({ processed: true, orderId: input.orderId }),
        },
        aiResponses: [
          // First call: AI wants to call a tool
          {
            response: "",
            tokensUsed: 20,
            toolCalls: [{ toolName: "order.find", args: { query: "pending" } }],
          },
          // Second call (after tool results): AI provides final response
          {
            response: "Found order ord-1 with amount 500. Processing complete.",
            tokensUsed: 30,
          },
        ],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithToolsFlow);

      const instance = await engine.startFlow("ai-tools-flow", {});

      expect(instance.status).toBe("completed");

      // AI was called twice: initial + follow-up
      expect(ctx.aiCalls).toHaveLength(2);

      // Tool was executed
      expect(ctx.actionCalls).toHaveLength(1);
      expect(ctx.actionCalls[0].name).toBe("order.find");
      expect(ctx.actionCalls[0].input).toEqual({ query: "pending" });

      // Follow-up prompt includes tool results
      expect(ctx.aiCalls[1].prompt).toContain("order.find");
      expect(ctx.aiCalls[1].prompt).toContain("ord-1");

      // Output includes tool call history
      const steps = instance.context.__steps as Record<string, { output: unknown }>;
      const output = steps["ai-with-tools"]?.output as Record<string, unknown>;
      expect(output.response).toBe("Found order ord-1 with amount 500. Processing complete.");
      expect(output.toolCalls).toBeDefined();
      expect(output.toolCalls as Array<unknown>).toHaveLength(1);
    });

    it("handles multiple tool calls in a single round", async () => {
      const ctx = createAIStepContext({
        actions: {
          "order.find": () => ({ id: "ord-1", amount: 100 }),
          "order.process": () => ({ processed: true }),
        },
        aiResponses: [
          // First call: AI wants to call two tools
          {
            response: "",
            tokensUsed: 20,
            toolCalls: [
              { toolName: "order.find", args: { query: "new" } },
              { toolName: "order.process", args: { orderId: "ord-1" } },
            ],
          },
          // Second call: final response
          {
            response: "All done",
            tokensUsed: 15,
          },
        ],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithToolsFlow);

      const instance = await engine.startFlow("ai-tools-flow", {});

      expect(instance.status).toBe("completed");
      expect(ctx.actionCalls).toHaveLength(2);
      expect(ctx.actionCalls[0].name).toBe("order.find");
      expect(ctx.actionCalls[1].name).toBe("order.process");
    });

    it("handles multi-round tool calls", async () => {
      const ctx = createAIStepContext({
        actions: {
          "order.find": () => ({ id: "ord-1" }),
          "order.process": () => ({ processed: true }),
        },
        aiResponses: [
          // Round 1: call order.find
          {
            response: "",
            tokensUsed: 10,
            toolCalls: [{ toolName: "order.find", args: { query: "test" } }],
          },
          // Round 2: now call order.process
          {
            response: "",
            tokensUsed: 10,
            toolCalls: [{ toolName: "order.process", args: { orderId: "ord-1" } }],
          },
          // Round 3: final response
          {
            response: "Completed in 2 rounds",
            tokensUsed: 15,
          },
        ],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithToolsFlow);

      const instance = await engine.startFlow("ai-tools-flow", {});

      expect(instance.status).toBe("completed");
      expect(ctx.aiCalls).toHaveLength(3); // 1 initial + 2 follow-ups
      expect(ctx.actionCalls).toHaveLength(2); // 2 tool calls total

      const steps = instance.context.__steps as Record<string, { output: unknown }>;
      const output = steps["ai-with-tools"]?.output as Record<string, unknown>;
      expect(output.response).toBe("Completed in 2 rounds");
      expect(output.tokensUsed).toBe(35); // 10 + 10 + 15
    });

    it("handles tool call errors gracefully", async () => {
      const ctx = createAIStepContext({
        actions: {
          "order.find": () => {
            throw new Error("Database connection failed");
          },
        },
        aiResponses: [
          // AI requests a tool call
          {
            response: "",
            tokensUsed: 10,
            toolCalls: [{ toolName: "order.find", args: { query: "test" } }],
          },
          // After error, AI responds gracefully
          {
            response: "Could not find the order due to a database error",
            tokensUsed: 20,
          },
        ],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiWithToolsFlow);

      const instance = await engine.startFlow("ai-tools-flow", {});

      expect(instance.status).toBe("completed");

      // Follow-up prompt should contain the error
      expect(ctx.aiCalls[1].prompt).toContain("Database connection failed");

      const steps = instance.context.__steps as Record<string, { output: unknown }>;
      const output = steps["ai-with-tools"]?.output as Record<string, unknown>;
      expect(output.response).toBe("Could not find the order due to a database error");
    });
  });

  describe("AI step with condition branching", () => {
    it("executes AI step after condition branch", async () => {
      const ctx = createAIStepContext({
        aiResponses: [{ response: "Analysis from branch", tokensUsed: 25 }],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(aiAfterConditionFlow);

      const instance = await engine.startFlow("ai-after-condition", {});

      expect(instance.status).toBe("completed");
      expect(ctx.aiCalls).toHaveLength(1);
      expect(ctx.aiCalls[0].prompt).toBe("Do analysis");
    });
  });

  describe("AI step error handling", () => {
    it("marks flow as failed when AI service throws", async () => {
      const ctx: FlowStepContext = {
        flowContext: {},
        async executeAction() {
          return {};
        },
        async callAI() {
          throw new Error("AI service unavailable");
        },
        evaluateCondition() {
          return false;
        },
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(simpleAIFlow);

      const instance = await engine.startFlow("simple-ai-flow", {});

      expect(instance.status).toBe("failed");
      expect(instance.error?.stepId).toBe("ai-step");
      expect(instance.error?.message).toContain("AI service unavailable");
    });
  });

  describe("AI step in parallel context", () => {
    it("executes AI steps within a parallel step (sequentially in sync mode)", async () => {
      const flow: FlowDefinition = {
        name: "parallel-ai-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "ai-1",
            name: "AI Analysis 1",
            type: "ai",
            prompt: "Analyze aspect A",
          },
          {
            id: "ai-2",
            name: "AI Analysis 2",
            type: "ai",
            prompt: "Analyze aspect B",
          },
          {
            id: "parallel",
            name: "Run AI in parallel",
            type: "parallel",
            steps: ["ai-1", "ai-2"],
          },
        ],
      };

      const _callIdx = 0;
      const ctx = createAIStepContext({
        aiResponses: [
          // First run of ai-1 (sequential step)
          { response: "A result (seq)", tokensUsed: 10 },
          // First run of ai-2 (sequential step)
          { response: "B result (seq)", tokensUsed: 10 },
          // Parallel run of ai-1
          { response: "A result (parallel)", tokensUsed: 15 },
          // Parallel run of ai-2
          { response: "B result (parallel)", tokensUsed: 15 },
        ],
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("parallel-ai-flow", {});

      expect(instance.status).toBe("completed");
      // 4 AI calls total: 2 sequential + 2 in parallel
      expect(ctx.aiCalls).toHaveLength(4);
    });
  });
});
