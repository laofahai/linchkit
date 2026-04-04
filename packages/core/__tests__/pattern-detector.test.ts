import { beforeEach, describe, expect, it } from "bun:test";
import { PatternDetector } from "../src/ai/pattern-detector";
import { InMemoryExecutionLogger } from "../src/observability/execution-logger";
import type { ExecutionLogEntry } from "../src/types/execution-log";

// ── Test helpers ──────────────────────────────────────────

function createLog(overrides: Partial<ExecutionLogEntry>): ExecutionLogEntry {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    action: "create_order",
    actor: { type: "user", id: "user-1", groups: [] },
    input: {},
    status: "succeeded",
    duration: 50,
    startedAt: new Date(),
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function _hoursAgo(n: number, minuteOffset = 0): Date {
  const d = new Date();
  d.setHours(d.getHours() - n, minuteOffset, 0, 0);
  return d;
}

// ── Repetitive Action Detection ──────────────────────────

describe("PatternDetector", () => {
  let logger: InMemoryExecutionLogger;

  beforeEach(() => {
    logger = new InMemoryExecutionLogger();
  });

  describe("repetitive action patterns", () => {
    it("detects repeated actions with same field value", async () => {
      // Create 10 logs where the same user always approves with amount < 5000
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "approve_request",
            entity: "purchase_request",
            input: { amount: 3000, decision: "approved" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const repetitive = insights.filter((i) => i.type === "repetitive_action");
      expect(repetitive.length).toBeGreaterThan(0);

      const decisionInsight = repetitive.find((i) => i.description.includes("decision"));
      expect(decisionInsight).toBeDefined();
      expect(decisionInsight?.confidence).toBeGreaterThanOrEqual(0.7);
      expect(decisionInsight?.entity).toBe("purchase_request");
      expect(decisionInsight?.suggestedAction.type).toBe("add_rule");
    });

    it("does not detect patterns below minimum occurrences", async () => {
      for (let i = 0; i < 3; i++) {
        logger.log(
          createLog({
            action: "approve_request",
            entity: "purchase_request",
            input: { decision: "approved" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5 });
      const insights = await detector.analyze(logger);
      const repetitive = insights.filter((i) => i.type === "repetitive_action");
      expect(repetitive).toHaveLength(0);
    });

    it("does not detect patterns with diverse values", async () => {
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "approve_request",
            entity: "purchase_request",
            input: { amount: i * 1000, decision: i % 2 === 0 ? "approved" : "rejected" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.9 });
      const insights = await detector.analyze(logger);
      // decision field is 50/50, so should not meet 0.9 confidence
      const decisionInsight = insights.find(
        (i) => i.type === "repetitive_action" && i.description.includes("decision"),
      );
      expect(decisionInsight).toBeUndefined();
    });
  });

  // ── Default Value Detection ────────────────────────────

  describe("default value patterns", () => {
    it("detects fields that almost always have the same value", async () => {
      for (let i = 0; i < 20; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: "USD", amount: i * 100 },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const defaults = insights.filter((i) => i.type === "default_value");
      const currencyInsight = defaults.find((i) => i.description.includes("currency"));
      expect(currencyInsight).toBeDefined();
      expect(currencyInsight?.confidence).toBe(1.0);
      expect(currencyInsight?.suggestedAction.type).toBe("modify_schema");
      expect(currencyInsight?.suggestedAction.details.defaultValue).toBe("USD");
    });

    it("does not flag fields with diverse values", async () => {
      const currencies = ["USD", "EUR", "GBP", "JPY", "CAD"];
      for (let i = 0; i < 20; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: currencies[i % currencies.length] },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);
      const currencyInsight = insights.find(
        (i) => i.type === "default_value" && i.description.includes("currency"),
      );
      // Each currency appears 4 times = 20%, well below 70%
      expect(currencyInsight).toBeUndefined();
    });
  });

  // ── Validation Pattern Detection ───────────────────────

  describe("validation patterns", () => {
    it("detects email-like patterns in string fields", async () => {
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "create_contact",
            entity: "contact",
            input: { email: `user${i}@example.com`, name: `User ${i}` },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const validations = insights.filter((i) => i.type === "validation_pattern");
      const emailInsight = validations.find((i) => i.description.includes("email"));
      expect(emailInsight).toBeDefined();
      expect(emailInsight?.description).toContain("email");
      expect(emailInsight?.suggestedAction.type).toBe("add_rule");
    });

    it("detects numeric string patterns", async () => {
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "create_item",
            entity: "item",
            input: { sku: `${1000 + i}`, name: "Widget" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const validations = insights.filter((i) => i.type === "validation_pattern");
      const skuInsight = validations.find((i) => i.description.includes("sku"));
      expect(skuInsight).toBeDefined();
    });
  });

  // ── State Flow Pattern Detection ───────────────────────

  describe("state flow patterns", () => {
    it("detects dominant state transition paths", async () => {
      // 8 records follow draft→submitted→approved
      for (let i = 0; i < 8; i++) {
        const recordId = `rec-${i}`;
        logger.log(
          createLog({
            action: "submit_request",
            entity: "purchase_request",
            recordId,
            stateTransition: { from: "draft", to: "submitted" },
            startedAt: daysAgo(10 - i),
          }),
        );
        logger.log(
          createLog({
            action: "approve_request",
            entity: "purchase_request",
            recordId,
            stateTransition: { from: "submitted", to: "approved" },
            startedAt: daysAgo(9 - i),
          }),
        );
      }
      // 2 records follow draft→submitted→rejected (minority)
      for (let i = 0; i < 2; i++) {
        const recordId = `rec-rej-${i}`;
        logger.log(
          createLog({
            action: "submit_request",
            entity: "purchase_request",
            recordId,
            stateTransition: { from: "draft", to: "submitted" },
            startedAt: daysAgo(5 - i),
          }),
        );
        logger.log(
          createLog({
            action: "reject_request",
            entity: "purchase_request",
            recordId,
            stateTransition: { from: "submitted", to: "rejected" },
            startedAt: daysAgo(4 - i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const flowInsights = insights.filter((i) => i.type === "state_flow");
      expect(flowInsights.length).toBeGreaterThan(0);

      const dominantFlow = flowInsights[0];
      expect(dominantFlow.description).toContain("draft");
      expect(dominantFlow.description).toContain("approved");
      expect(dominantFlow.suggestedAction.type).toBe("add_automation");
    });
  });

  // ── Timing Pattern Detection ───────────────────────────

  describe("timing patterns", () => {
    it("detects hour-of-day concentration", async () => {
      // 8 out of 10 executions happen at 9am
      for (let i = 0; i < 8; i++) {
        const d = daysAgo(i);
        d.setHours(9, 0, 0, 0);
        logger.log(
          createLog({
            action: "daily_review",
            entity: "task",
            input: { status: "reviewed" },
            startedAt: d,
          }),
        );
      }
      // 2 at random other times
      for (let i = 0; i < 2; i++) {
        const d = daysAgo(i + 10);
        d.setHours(15, 0, 0, 0);
        logger.log(
          createLog({
            action: "daily_review",
            entity: "task",
            input: { status: "reviewed" },
            startedAt: d,
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyze(logger);

      const timingInsights = insights.filter((i) => i.type === "timing");
      expect(timingInsights.length).toBeGreaterThan(0);

      const hourInsight = timingInsights.find((i) => i.description.includes("9:00"));
      expect(hourInsight).toBeDefined();
      expect(hourInsight?.suggestedAction.type).toBe("add_automation");
    });
  });

  // ── Schema-specific analysis ───────────────────────────

  describe("analyzeSchema", () => {
    it("only analyzes logs for the specified schema", async () => {
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: "USD" },
            startedAt: daysAgo(i),
          }),
        );
        logger.log(
          createLog({
            action: "create_task",
            entity: "task",
            input: { priority: "high" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
      const insights = await detector.analyzeSchema(logger, "order");

      // Should only find order-related patterns
      for (const insight of insights) {
        expect(insight.entity).toBe("order");
      }
    });
  });

  // ── Configuration ──────────────────────────────────────

  describe("configuration", () => {
    it("respects enabledPatterns filter", async () => {
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "approve_request",
            entity: "request",
            input: { decision: "approved" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({
        minOccurrences: 5,
        minConfidence: 0.7,
        enabledPatterns: ["default_value"], // Only detect default_value
      });
      const insights = await detector.analyze(logger);

      // Should not find repetitive_action patterns
      const repetitive = insights.filter((i) => i.type === "repetitive_action");
      expect(repetitive).toHaveLength(0);
    });

    it("filters by minConfidence threshold", async () => {
      // Create 10 logs, 6 with "USD" and 4 with "EUR"
      for (let i = 0; i < 6; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: "USD" },
            startedAt: daysAgo(i),
          }),
        );
      }
      for (let i = 0; i < 4; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: "EUR" },
            startedAt: daysAgo(i + 6),
          }),
        );
      }

      // At 0.5 confidence threshold, USD at 60% should pass
      const detectorLow = new PatternDetector({
        minOccurrences: 5,
        minConfidence: 0.5,
        enabledPatterns: ["default_value"],
      });
      const insightsLow = await detectorLow.analyze(logger);
      expect(insightsLow.filter((i) => i.type === "default_value").length).toBeGreaterThan(0);

      // At 0.9 confidence threshold, USD at 60% should not pass
      const detectorHigh = new PatternDetector({
        minOccurrences: 5,
        minConfidence: 0.9,
        enabledPatterns: ["default_value"],
      });
      const insightsHigh = await detectorHigh.analyze(logger);
      expect(insightsHigh.filter((i) => i.type === "default_value")).toHaveLength(0);
    });

    it("returns insights sorted by confidence descending", async () => {
      // Mix of patterns with different confidence levels
      for (let i = 0; i < 10; i++) {
        logger.log(
          createLog({
            action: "create_order",
            entity: "order",
            input: { currency: "USD", region: i % 2 === 0 ? "US" : "EU" },
            startedAt: daysAgo(i),
          }),
        );
      }

      const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.5 });
      const insights = await detector.analyze(logger);

      for (let i = 1; i < insights.length; i++) {
        expect(insights[i].confidence).toBeLessThanOrEqual(insights[i - 1].confidence);
      }
    });

    it("returns empty array for empty logs", async () => {
      const detector = new PatternDetector();
      const insights = await detector.analyze(logger);
      expect(insights).toHaveLength(0);
    });
  });
});
