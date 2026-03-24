/**
 * Tests for FlowStepContext factory
 *
 * Verifies that createFlowStepContext correctly wires:
 * - callAI → AIService.complete()
 * - tool resolution from action registry
 * - executeAction → action engine delegation
 * - evaluateCondition fallback
 */

import { describe, expect, it } from "bun:test";
import { mockAIService } from "@linchkit/devtools";
import { createFlowStepContext } from "../src/flow/flow-step-context";
import type { ActionDefinition } from "../src/types/action";

// ── Helpers ──────────────────────────────────────────────

function createMockActionEngine() {
  const calls: Array<{ actionName: string; input: Record<string, unknown> }> = [];

  return {
    calls,
    async execute(actionName: string, input: Record<string, unknown>) {
      calls.push({ actionName, input });
      return {
        success: true,
        data: { id: "result-1", processed: true },
        executionId: "exec-1",
      };
    },
  };
}

function createMockActionRegistry(actions: ActionDefinition[]) {
  const map = new Map<string, ActionDefinition>();
  for (const a of actions) {
    map.set(a.name, a);
  }
  return {
    get: (name: string) => map.get(name),
  };
}

const sampleAction: ActionDefinition = {
  name: "order.approve",
  schema: "order",
  label: "Approve Order",
  description: "Approve a purchase order",
  input: {
    orderId: { type: "string", label: "Order ID", required: true },
    amount: { type: "number", label: "Amount" },
    notes: { type: "text", label: "Notes" },
  },
  policy: { mode: "sync", transaction: false },
};

// ── Tests ────────────────────────────────────────────────

describe("createFlowStepContext", () => {
  describe("callAI", () => {
    it("maps prompt to a single user message", async () => {
      const ai = mockAIService({ "hello world": "AI response here" });
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      const result = await ctx.callAI({ prompt: "hello world" });

      expect(result.response).toBe("AI response here");
      expect(result.tokensUsed).toBe(30);

      // Verify the message was sent as a user message
      expect(ai.calls).toHaveLength(1);
      expect(ai.calls[0].messages).toEqual([{ role: "user", content: "hello world" }]);
    });

    it("passes model alias through to AIService", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      await ctx.callAI({ prompt: "test", model: "fast" });

      expect(ai.calls[0].model).toBe("fast");
    });

    it("resolves tool names from action registry", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();
      const registry = createMockActionRegistry([sampleAction]);

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
        actionRegistry: registry,
      });

      await ctx.callAI({
        prompt: "approve this order",
        tools: ["order.approve"],
      });

      expect(ai.calls[0].tools).toBeDefined();
      expect(ai.calls[0].tools).toHaveLength(1);

      const tool = ai.calls[0].tools?.[0];
      expect(tool.name).toBe("order.approve");
      expect(tool.description).toBe("Approve a purchase order");
      expect(tool.parameters).toEqual({
        type: "object",
        properties: {
          orderId: { type: "string", description: "Order ID" },
          amount: { type: "number", description: "Amount" },
          notes: { type: "string", description: "Notes" },
        },
        required: ["orderId"],
      });
    });

    it("skips unknown tool names gracefully", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();
      const registry = createMockActionRegistry([sampleAction]);

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
        actionRegistry: registry,
      });

      await ctx.callAI({
        prompt: "test",
        tools: ["nonexistent.action"],
      });

      // No tools should be passed since none resolved
      expect(ai.calls[0].tools).toBeUndefined();
    });

    it("ignores tools when no action registry is provided", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
        // No actionRegistry
      });

      await ctx.callAI({
        prompt: "test",
        tools: ["order.approve"],
      });

      // tools should not be set since there's no registry
      expect(ai.calls[0].tools).toBeUndefined();
    });

    it("returns default response and token count", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      const result = await ctx.callAI({ prompt: "anything" });

      expect(result.response).toBe("mock response");
      expect(result.tokensUsed).toBe(30);
    });
  });

  describe("executeAction", () => {
    it("delegates to action engine and returns data", async () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      const result = await ctx.executeAction("order.approve", {
        orderId: "o1",
      });

      expect(engine.calls).toHaveLength(1);
      expect(engine.calls[0]).toEqual({
        actionName: "order.approve",
        input: { orderId: "o1" },
      });
      expect(result).toEqual({ id: "result-1", processed: true });
    });

    it("handles non-ActionResult returns gracefully", async () => {
      const ai = mockAIService();
      const engine = {
        async execute() {
          return { rawValue: 42 };
        },
      };

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      const result = await ctx.executeAction("some.action", {});
      expect(result).toEqual({ rawValue: 42 });
    });
  });

  describe("evaluateCondition", () => {
    it("returns false as fallback", () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      expect(ctx.evaluateCondition("some complex expression", {})).toBe(false);
    });
  });

  describe("flowContext", () => {
    it("initializes with empty object", () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      expect(ctx.flowContext).toEqual({});
    });

    it("is mutable for sync engine to populate", () => {
      const ai = mockAIService();
      const engine = createMockActionEngine();

      const ctx = createFlowStepContext({
        aiService: ai,
        actionEngine: engine,
      });

      ctx.flowContext.__input = { key: "value" };
      expect(ctx.flowContext.__input).toEqual({ key: "value" });
    });
  });
});
