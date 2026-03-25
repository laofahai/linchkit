/**
 * Tests for AIBoundary integration with Flow engine AI steps
 *
 * Verifies:
 * - AI step with boundary — rate limits and policies apply
 * - AI step without boundary — backward compatible (direct AI service call)
 * - AI step blocked by boundary — step fails gracefully with AIBoundaryError
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AIBoundary } from "../src/ai/ai-boundary";
import type { AIPolicy } from "../src/ai/ai-policy";
import { createFlowStepContext } from "../src/flow/flow-step-context";
import { createSyncFlowEngine } from "../src/flow/sync-engine";
import type { AICompletionResult, AIService } from "../src/types/ai";
import type { FlowDefinition } from "../src/types/flow";

// ── Helpers ─────────────────────────────────────────────

function createMockAIService(result?: Partial<AICompletionResult>): AIService {
  const defaultResult: AICompletionResult = {
    content: "AI response for flow",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
    },
    model: "test-model",
    provider: "test-provider",
    duration: 200,
    ...result,
  };

  return {
    complete: mock(() => Promise.resolve(defaultResult)),
  };
}

function createMockActionEngine() {
  return {
    execute: mock(async () => ({ success: true, data: { id: "1" } })),
  };
}

/** Simple flow with a single AI step */
const AI_FLOW: FlowDefinition = {
  name: "ai-test-flow",
  description: "Flow with AI step for boundary testing",
  trigger: { type: "manual" },
  steps: [
    {
      id: "ask-ai",
      type: "ai" as const,
      prompt: "Summarize the input",
      model: "test-model",
    },
  ],
};

// ── Tests ───────────────────────────────────────────────

describe("AIBoundary + Flow Engine integration", () => {
  let aiService: AIService;
  let actionEngine: ReturnType<typeof createMockActionEngine>;

  beforeEach(() => {
    aiService = createMockAIService();
    actionEngine = createMockActionEngine();
  });

  // ── 1. AI step with boundary — policies apply ──────────

  describe("AI step with boundary", () => {
    it("should route AI calls through the boundary", async () => {
      const boundary = new AIBoundary({ aiService });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      const instance = await engine.startFlow("ai-test-flow", { text: "hello" });

      expect(instance.status).toBe("completed");

      // Verify AIService.complete was called (through boundary)
      expect(aiService.complete).toHaveBeenCalledTimes(1);

      // Verify usage was recorded in boundary
      const records = boundary.getUsageRecords({ source: "flow" });
      expect(records.length).toBe(1);
      expect(records[0].source).toBe("flow");
      expect(records[0].status).toBe("allowed");
      expect(records[0].actionName).toBe("ai-test-flow");
    });

    it("should pass tenantId and actorId to boundary request", async () => {
      const boundary = new AIBoundary({ aiService });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      await engine.startFlow(
        "ai-test-flow",
        {},
        {
          tenantId: "tenant-1",
          actor: { type: "user", id: "user-42", name: "Test User", groups: [] },
        },
      );

      const records = boundary.getUsageRecords({ source: "flow" });
      expect(records.length).toBe(1);
      expect(records[0].tenantId).toBe("tenant-1");
      expect(records[0].actorId).toBe("user-42");
    });

    it("should enforce rate limits on AI flow steps", async () => {
      const strictPolicy: AIPolicy = {
        name: "strict-flow-policy",
        rateLimits: {
          maxRequestsPerMinute: 2,
        },
      };

      const boundary = new AIBoundary({
        aiService,
        defaultPolicy: strictPolicy,
      });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      // First two calls should succeed
      const result1 = await engine.startFlow("ai-test-flow", { n: 1 });
      expect(result1.status).toBe("completed");

      const result2 = await engine.startFlow("ai-test-flow", { n: 2 });
      expect(result2.status).toBe("completed");

      // Third call should be rate limited — flow fails
      const result3 = await engine.startFlow("ai-test-flow", { n: 3 });
      expect(result3.status).toBe("failed");
      expect(result3.error?.message).toContain("Rate limit exceeded");
    });
  });

  // ── 2. AI step without boundary — backward compatible ──

  describe("AI step without boundary (backward compatible)", () => {
    it("should call AI service directly when no boundary is set", async () => {
      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        // No aiBoundary — backward compatible
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      const instance = await engine.startFlow("ai-test-flow", { text: "hello" });

      expect(instance.status).toBe("completed");
      expect(aiService.complete).toHaveBeenCalledTimes(1);

      // Verify output is stored in flow context
      const stepsCtx = instance.context?.__steps as Record<string, Record<string, unknown>>;
      const aiOutput = stepsCtx["ask-ai"]?.output as Record<string, unknown>;
      expect(aiOutput?.response).toBe("AI response for flow");
      expect(aiOutput?.tokensUsed).toBe(150);
    });
  });

  // ── 3. AI step blocked by boundary — graceful failure ──

  describe("AI step blocked by boundary", () => {
    it("should fail the flow step gracefully when boundary blocks the call", async () => {
      const blockingPolicy: AIPolicy = {
        name: "block-all",
        rateLimits: {
          maxRequestsPerMinute: 0, // Block everything
        },
      };

      const boundary = new AIBoundary({
        aiService,
        defaultPolicy: blockingPolicy,
      });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      const instance = await engine.startFlow("ai-test-flow", { text: "hello" });

      // Flow should fail, not crash
      expect(instance.status).toBe("failed");
      expect(instance.error).toBeDefined();
      expect(instance.error?.stepId).toBe("ask-ai");
      expect(instance.error?.message).toContain("Rate limit exceeded");

      // AI service should NOT have been called
      expect(aiService.complete).not.toHaveBeenCalled();
    });

    it("should fail gracefully when budget is exceeded", async () => {
      const budgetPolicy: AIPolicy = {
        name: "zero-budget",
        budget: {
          maxCostPerDay: 0, // Zero budget — blocks all AI calls
        },
      };

      const boundary = new AIBoundary({
        aiService,
        defaultPolicy: budgetPolicy,
      });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      const instance = await engine.startFlow("ai-test-flow", {});

      expect(instance.status).toBe("failed");
      expect(instance.error?.message).toContain("budget exceeded");

      // Blocked call should be recorded
      const records = boundary.getUsageRecords();
      expect(records.length).toBe(1);
      expect(records[0].status).toBe("budget_exceeded");
    });

    it("should record blocked AI calls in usage log", async () => {
      const blockingPolicy: AIPolicy = {
        name: "deny-all",
        allowDirectDataModification: false,
        rateLimits: { maxRequestsPerMinute: 0 },
      };

      const usageRecords: unknown[] = [];
      const boundary = new AIBoundary({
        aiService,
        defaultPolicy: blockingPolicy,
        onUsageRecord: (record) => usageRecords.push(record),
      });

      const stepContext = createFlowStepContext({
        aiService,
        actionEngine,
        aiBoundary: boundary,
        flowName: "ai-test-flow",
      });

      const engine = createSyncFlowEngine(stepContext);
      engine.registerFlow(AI_FLOW);

      await engine.startFlow("ai-test-flow", {});

      // onUsageRecord callback should have been invoked
      expect(usageRecords.length).toBe(1);
    });
  });
});
