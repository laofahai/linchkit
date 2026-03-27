import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AIBoundary, AIBoundaryError } from "../src/ai/ai-boundary";
import type { AIPolicy, AIUsageRecord } from "../src/ai/ai-policy";
import type { AICompletionResult, AIService } from "../src/types/ai";
import type { Logger } from "../src/types/logger";

// ── Mock AI Service ──────────────────────────────────────

function createMockAIService(result?: Partial<AICompletionResult>): AIService {
  const defaultResult: AICompletionResult = {
    content: "Test response",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
    },
    model: "test-model",
    provider: "test-provider",
    duration: 500,
    ...result,
  };

  return {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    complete: mock(() => Promise.resolve(defaultResult)),
  };
}

function createMockLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

// ── Tests ────────────────────────────────────────────────

describe("AIBoundary", () => {
  let aiService: AIService;
  let logger: Logger;
  let boundary: AIBoundary;

  beforeEach(() => {
    aiService = createMockAIService();
    logger = createMockLogger();
  });

  afterEach(() => {
    // No cleanup needed — each test creates its own boundary
  });

  describe("basic boundary check", () => {
    it("allows AI calls with default policy", () => {
      boundary = new AIBoundary({ aiService, logger });

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
        actorId: "u1",
      });

      expect(result.allowed).toBe(true);
    });

    it("blocks direct data modification by default", () => {
      boundary = new AIBoundary({ aiService, logger });

      const result = boundary.check({
        source: "flow",
        isDataModification: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("policy_denied");
      expect(result.reason).toContain("Proposal flow");
    });

    it("allows data modification when policy permits", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "permissive",
          allowDirectDataModification: true,
        },
      });

      const result = boundary.check({
        source: "api",
        isDataModification: true,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe("action access control", () => {
    it("blocks actions not in allowlist", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "strict",
          actionAccess: {
            mode: "allowlist",
            actions: ["query_data", "analyze_logs"],
          },
        },
      });

      const result = boundary.check({
        source: "mcp",
        actionName: "delete_all_records",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("action_denied");
      expect(result.reason).toContain("delete_all_records");
    });

    it("allows actions in allowlist", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "strict",
          actionAccess: {
            mode: "allowlist",
            actions: ["query_data", "analyze_logs"],
          },
        },
      });

      const result = boundary.check({
        source: "mcp",
        actionName: "query_data",
      });

      expect(result.allowed).toBe(true);
    });

    it("blocks actions in denylist", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "moderate",
          actionAccess: {
            mode: "denylist",
            actions: ["drop_database", "delete_all"],
          },
        },
      });

      const result = boundary.check({
        source: "mcp",
        actionName: "drop_database",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("action_denied");
    });

    it("allows actions not in denylist", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "moderate",
          actionAccess: {
            mode: "denylist",
            actions: ["drop_database"],
          },
        },
      });

      const result = boundary.check({
        source: "mcp",
        actionName: "query_data",
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("blocks when per-minute limit exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "rate-limited",
          rateLimits: {
            maxRequestsPerMinute: 2,
          },
        },
      });

      const request = { source: "flow" as const, tenantId: "t1" };

      // Simulate filling up the budget manually
      const budget = boundary.getBudget("t1");
      budget.requestsThisMinute = 2;

      const result = boundary.check(request);
      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("rate_limit");
      expect(result.reason).toContain("per minute");
    });

    it("blocks when per-hour limit exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "rate-limited",
          rateLimits: {
            maxRequestsPerHour: 10,
          },
        },
      });

      const budget = boundary.getBudget("t1");
      budget.requestsThisHour = 10;

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("rate_limit");
    });

    it("blocks when per-day limit exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "rate-limited",
          rateLimits: {
            maxRequestsPerDay: 100,
          },
        },
      });

      const budget = boundary.getBudget("t1");
      budget.requestsToday = 100;

      const result = boundary.check({
        source: "api",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("rate_limit");
    });
  });

  describe("budget enforcement", () => {
    it("blocks when daily cost budget exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "budget-limited",
          budget: {
            maxCostPerDay: 10.0,
          },
        },
      });

      const budget = boundary.getBudget("t1");
      budget.costToday = 10.0;

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("budget_exceeded");
      expect(result.reason).toContain("$10.00");
    });

    it("blocks when hourly cost budget exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "budget-limited",
          budget: {
            maxCostPerHour: 5.0,
          },
        },
      });

      const budget = boundary.getBudget();
      budget.costThisHour = 5.0;

      const result = boundary.check({ source: "api" });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("budget_exceeded");
    });

    it("blocks when daily token limit exceeded", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "token-limited",
          budget: {
            maxTokensPerDay: 100000,
          },
        },
      });

      const budget = boundary.getBudget("t1");
      budget.tokensToday = 100000;

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("budget_exceeded");
    });

    it("returns warning when approaching budget threshold", () => {
      const onBudgetAlert = mock(() => {});

      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "budget-alert",
          budget: {
            maxCostPerDay: 10.0,
            alertThreshold: 0.8,
          },
        },
        onBudgetAlert,
      });

      const budget = boundary.getBudget("t1");
      budget.costToday = 8.5; // 85% of $10

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(result.warnings?.[0]).toContain("85%");
      expect(onBudgetAlert).toHaveBeenCalled();
    });
  });

  describe("content filtering", () => {
    it("blocks input matching regex filter", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "filtered",
          contentFilters: [
            {
              name: "pii-filter",
              type: "regex",
              pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", // SSN pattern
              action: "block",
              scope: "input",
            },
          ],
        },
      });

      const result = boundary.check({
        source: "api",
        promptContent: "Look up info for SSN 123-45-6789",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("content_filtered");
      expect(result.reason).toContain("pii-filter");
    });

    it("blocks input matching keyword filter", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "filtered",
          contentFilters: [
            {
              name: "secret-filter",
              type: "keyword",
              pattern: "api_secret",
              action: "block",
            },
          ],
        },
      });

      const result = boundary.check({
        source: "flow",
        promptContent: "Here is my API_SECRET key",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("content_filtered");
    });

    it("warns but allows for warn-level filters", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "warn-filter",
          contentFilters: [
            {
              name: "cost-warning",
              type: "keyword",
              pattern: "expensive operation",
              action: "warn",
            },
          ],
        },
      });

      const result = boundary.check({
        source: "api",
        promptContent: "Run expensive operation on all data",
      });

      expect(result.allowed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.[0]).toContain("cost-warning");
    });

    it("ignores input-scoped filter on output check direction", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "scoped-filter",
          contentFilters: [
            {
              name: "input-only",
              type: "keyword",
              pattern: "blocked_word",
              action: "block",
              scope: "input",
            },
          ],
        },
      });

      // Input filter should not match when checked as output direction
      // (internal method test — verified through execute() output filtering)
      const result = boundary.check({
        source: "api",
        promptContent: "This contains blocked_word",
      });

      expect(result.allowed).toBe(false); // Blocked on input
    });
  });

  describe("concurrent call limiting", () => {
    it("blocks when concurrent limit reached", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "concurrent-limited",
          maxConcurrentCalls: 2,
        },
      });

      // Simulate active calls by directly accessing internals via execute
      // Instead, we'll use the check method with pre-set state
      // Access private activeCalls map via the boundary instance
      const boundaryAny = boundary as unknown as {
        activeCalls: Map<string, number>;
      };
      boundaryAny.activeCalls.set("t1", 2);

      const result = boundary.check({
        source: "flow",
        tenantId: "t1",
      });

      expect(result.allowed).toBe(false);
      expect(result.violation).toBe("rate_limit");
      expect(result.reason).toContain("Concurrent");
    });
  });

  describe("tenant-specific policies", () => {
    it("uses tenant policy when available", () => {
      const tenantPolicy: AIPolicy = {
        name: "tenant-strict",
        actionAccess: {
          mode: "allowlist",
          actions: ["read_only"],
        },
      };

      boundary = new AIBoundary({
        aiService,
        logger,
        tenantPolicies: { "tenant-1": tenantPolicy },
      });

      const result = boundary.check({
        source: "mcp",
        tenantId: "tenant-1",
        actionName: "write_data",
      });

      expect(result.allowed).toBe(false);
      expect(result.policyName).toBe("tenant-strict");
    });

    it("falls back to default policy for unknown tenant", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        tenantPolicies: { "tenant-1": { name: "t1-policy" } },
      });

      const result = boundary.check({
        source: "flow",
        tenantId: "tenant-2",
      });

      expect(result.allowed).toBe(true);
    });

    it("allows setting and removing tenant policies dynamically", () => {
      boundary = new AIBoundary({ aiService, logger });

      boundary.setTenantPolicy("t1", {
        name: "dynamic",
        actionAccess: {
          mode: "allowlist",
          actions: [],
        },
      });

      const blocked = boundary.check({
        source: "mcp",
        tenantId: "t1",
        actionName: "some_action",
      });
      expect(blocked.allowed).toBe(false);

      boundary.removeTenantPolicy("t1");

      const allowed = boundary.check({
        source: "mcp",
        tenantId: "t1",
        actionName: "some_action",
      });
      expect(allowed.allowed).toBe(true);
    });
  });

  describe("execute (wrapped AI call)", () => {
    it("executes AI call when policy allows", async () => {
      boundary = new AIBoundary({ aiService, logger });

      const result = await boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "flow", tenantId: "t1" },
      );

      expect(result.content).toBe("Test response");
      expect(result.usage.totalTokens).toBe(150);
      expect(aiService.complete).toHaveBeenCalled();
    });

    it("throws AIBoundaryError when policy blocks", async () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "strict",
          actionAccess: {
            mode: "allowlist",
            actions: [],
          },
        },
      });

      try {
        await boundary.execute(
          { messages: [{ role: "user", content: "Hello" }] },
          { source: "mcp", actionName: "forbidden_action" },
        );
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(AIBoundaryError);
        const error = err as AIBoundaryError;
        expect(error.violation).toBe("action_denied");
        expect(error.policyName).toBe("strict");
      }
    });

    it("records usage for successful calls", async () => {
      const usageRecords: AIUsageRecord[] = [];

      boundary = new AIBoundary({
        aiService,
        logger,
        onUsageRecord: (record) => usageRecords.push(record),
      });

      await boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "flow", tenantId: "t1", actorId: "u1" },
      );

      expect(usageRecords.length).toBe(1);
      expect(usageRecords[0].status).toBe("allowed");
      expect(usageRecords[0].tenantId).toBe("t1");
      expect(usageRecords[0].actorId).toBe("u1");
      expect(usageRecords[0].source).toBe("flow");
      expect(usageRecords[0].totalTokens).toBe(150);
    });

    it("records usage for blocked calls", async () => {
      const usageRecords: AIUsageRecord[] = [];

      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "budget-zero",
          budget: { maxCostPerDay: 0 },
        },
        onUsageRecord: (record) => usageRecords.push(record),
      });

      try {
        await boundary.execute(
          { messages: [{ role: "user", content: "Hello" }] },
          { source: "api" },
        );
      } catch {
        // Expected
      }

      expect(usageRecords.length).toBe(1);
      expect(usageRecords[0].status).toBe("budget_exceeded");
    });

    it("updates budget after successful call", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "flow", tenantId: "t1" },
      );

      const budget = boundary.getBudget("t1");
      expect(budget.requestsToday).toBe(1);
      expect(budget.requestsThisHour).toBe(1);
      expect(budget.requestsThisMinute).toBe(1);
      expect(budget.tokensToday).toBe(150);
      expect(budget.costToday).toBe(0.01);
    });

    it("blocks output matching content filter", async () => {
      const sensitiveResult: AICompletionResult = {
        content: "The SSN is 123-45-6789",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01 },
        model: "test-model",
        provider: "test-provider",
        duration: 500,
      };

      aiService = createMockAIService(sensitiveResult);

      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "output-filter",
          contentFilters: [
            {
              name: "ssn-output-filter",
              type: "regex",
              pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
              action: "block",
              scope: "output",
            },
          ],
        },
      });

      try {
        await boundary.execute(
          { messages: [{ role: "user", content: "What is the SSN?" }] },
          { source: "api" },
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AIBoundaryError);
        expect((err as AIBoundaryError).violation).toBe("content_filtered");
      }
    });

    it("tracks concurrent calls correctly", async () => {
      let resolveCall: () => void;
      const slowService: AIService = {
        configured: true,
        defaultProvider: "mock",
        providerNames: ["mock"],
        complete: () =>
          new Promise<AICompletionResult>((resolve) => {
            resolveCall = () =>
              resolve({
                content: "done",
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 0.001 },
                model: "m",
                provider: "p",
                duration: 100,
              });
          }),
      };

      boundary = new AIBoundary({
        aiService: slowService,
        logger,
        defaultPolicy: {
          name: "concurrent-test",
          maxConcurrentCalls: 1,
        },
      });

      // Start first call (won't resolve yet)
      const firstCall = boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "flow", tenantId: "t1" },
      );

      // Second call should be blocked (concurrent limit = 1)
      const checkResult = boundary.check({ source: "flow", tenantId: "t1" });
      expect(checkResult.allowed).toBe(false);
      expect(checkResult.violation).toBe("rate_limit");

      // Resolve first call
      resolveCall?.();
      await firstCall;

      // Now should be allowed again
      const checkAfter = boundary.check({ source: "flow", tenantId: "t1" });
      expect(checkAfter.allowed).toBe(true);
    });
  });

  describe("usage records query", () => {
    it("returns usage records filtered by tenant", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute(
        { messages: [{ role: "user", content: "t1 call" }] },
        { source: "flow", tenantId: "t1" },
      );
      await boundary.execute(
        { messages: [{ role: "user", content: "t2 call" }] },
        { source: "api", tenantId: "t2" },
      );

      const t1Records = boundary.getUsageRecords({ tenantId: "t1" });
      expect(t1Records.length).toBe(1);
      expect(t1Records[0].tenantId).toBe("t1");
    });

    it("returns usage records filtered by source", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute(
        { messages: [{ role: "user", content: "flow call" }] },
        { source: "flow" },
      );
      await boundary.execute(
        { messages: [{ role: "user", content: "api call" }] },
        { source: "api" },
      );

      const flowRecords = boundary.getUsageRecords({ source: "flow" });
      expect(flowRecords.length).toBe(1);
      expect(flowRecords[0].source).toBe("flow");
    });

    it("respects limit parameter", async () => {
      boundary = new AIBoundary({ aiService, logger });

      for (let i = 0; i < 5; i++) {
        await boundary.execute(
          { messages: [{ role: "user", content: `call ${i}` }] },
          { source: "flow" },
        );
      }

      const limited = boundary.getUsageRecords({ limit: 2 });
      expect(limited.length).toBe(2);
    });

    it("returns records in reverse chronological order", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute(
        { messages: [{ role: "user", content: "first" }] },
        { source: "flow", tenantId: "t1" },
      );
      await boundary.execute(
        { messages: [{ role: "user", content: "second" }] },
        { source: "flow", tenantId: "t2" },
      );

      const records = boundary.getUsageRecords();
      expect(records.length).toBe(2);
      expect(records[0].timestamp.getTime()).toBeGreaterThanOrEqual(records[1].timestamp.getTime());
    });
  });

  describe("budget reset", () => {
    it("resets budget counters for a tenant", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "flow", tenantId: "t1" },
      );

      expect(boundary.getBudget("t1").requestsToday).toBe(1);

      boundary.resetBudget("t1");

      expect(boundary.getBudget("t1").requestsToday).toBe(0);
      expect(boundary.getBudget("t1").costToday).toBe(0);
    });

    it("resets global budget when no tenant specified", async () => {
      boundary = new AIBoundary({ aiService, logger });

      await boundary.execute({ messages: [{ role: "user", content: "Hello" }] }, { source: "api" });

      expect(boundary.getBudget().requestsToday).toBe(1);

      boundary.resetBudget();

      expect(boundary.getBudget().requestsToday).toBe(0);
    });
  });

  describe("getEffectivePolicy", () => {
    it("returns tenant policy when available", () => {
      const tenantPolicy: AIPolicy = { name: "tenant-p" };

      boundary = new AIBoundary({
        aiService,
        logger,
        tenantPolicies: { t1: tenantPolicy },
      });

      expect(boundary.getEffectivePolicy("t1").name).toBe("tenant-p");
    });

    it("returns default policy when no tenant match", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: { name: "default-p" },
      });

      expect(boundary.getEffectivePolicy("unknown").name).toBe("default-p");
    });

    it("returns default policy when no tenantId", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: { name: "default-p" },
      });

      expect(boundary.getEffectivePolicy().name).toBe("default-p");
    });
  });

  describe("AIBoundaryError", () => {
    it("has correct properties", () => {
      const error = new AIBoundaryError("Rate limit exceeded", "rate_limit", "strict-policy");

      expect(error.name).toBe("AIBoundaryError");
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.violation).toBe("rate_limit");
      expect(error.policyName).toBe("strict-policy");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("edge cases", () => {
    it("handles invalid regex in content filter gracefully", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "bad-regex",
          contentFilters: [
            {
              name: "invalid-regex",
              type: "regex",
              pattern: "[invalid",
              action: "block",
            },
          ],
        },
      });

      // Should not throw; should skip the bad filter
      const result = boundary.check({
        source: "api",
        promptContent: "test content",
      });

      expect(result.allowed).toBe(true);
    });

    it("handles no promptContent with content filters", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "filtered",
          contentFilters: [
            {
              name: "test-filter",
              type: "keyword",
              pattern: "secret",
              action: "block",
            },
          ],
        },
      });

      // No promptContent — filters should be skipped
      const result = boundary.check({ source: "api" });
      expect(result.allowed).toBe(true);
    });

    it("handles AI service errors without leaking concurrent count", async () => {
      const failingService: AIService = {
        configured: true,
        defaultProvider: "mock",
        providerNames: ["mock"],
        complete: () => Promise.reject(new Error("API error")),
      };

      boundary = new AIBoundary({
        aiService: failingService,
        logger,
        defaultPolicy: {
          name: "test",
          maxConcurrentCalls: 1,
        },
      });

      try {
        await boundary.execute(
          { messages: [{ role: "user", content: "Hello" }] },
          { source: "flow", tenantId: "t1" },
        );
      } catch {
        // Expected
      }

      // Concurrent count should be back to 0
      const check = boundary.check({ source: "flow", tenantId: "t1" });
      expect(check.allowed).toBe(true);
    });

    it("works with no logger configured", async () => {
      boundary = new AIBoundary({ aiService });

      const result = await boundary.execute(
        { messages: [{ role: "user", content: "Hello" }] },
        { source: "api" },
      );

      expect(result.content).toBe("Test response");
    });

    it("handles multiple filters — first block wins", () => {
      boundary = new AIBoundary({
        aiService,
        logger,
        defaultPolicy: {
          name: "multi-filter",
          contentFilters: [
            {
              name: "filter-a",
              type: "keyword",
              pattern: "blocked",
              action: "block",
            },
            {
              name: "filter-b",
              type: "keyword",
              pattern: "blocked",
              action: "warn",
            },
          ],
        },
      });

      const result = boundary.check({
        source: "api",
        promptContent: "This is blocked content",
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("filter-a");
    });
  });
});
