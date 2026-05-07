import { beforeEach, describe, expect, test } from "bun:test";
import type { ExecutionLogEntry } from "@linchkit/core";
import { InMemoryExecutionLogger } from "@linchkit/core/server";
import { PatternDetector } from "../src/pattern-detector";

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

function _hoursAgoAt(hoursBack: number, targetHour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(hoursBack / 24));
  d.setHours(targetHour, 0, 0, 0);
  return d;
}

// ── Integration tests — full pipeline ────────────────────

describe("PatternDetector — integration with InMemoryExecutionLogger", () => {
  let logger: InMemoryExecutionLogger;

  beforeEach(() => {
    logger = new InMemoryExecutionLogger();
  });

  test("returns empty insights when no logs exist", async () => {
    const detector = new PatternDetector();
    const insights = await detector.analyze(logger);
    expect(insights).toHaveLength(0);
  });

  test("detects repetitive action pattern", async () => {
    // Log the same action 10 times with the same field value
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "approve_request",
          entity: "purchase_request",
          actor: { type: "user", id: "manager-1", groups: [] },
          input: { decision: "approve", reason: "standard" },
          startedAt: daysAgo(i % 7),
        }),
      );
    }

    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.7,
    });
    const insights = await detector.analyze(logger);

    const repetitiveInsights = insights.filter((i) => i.type === "repetitive_action");
    expect(repetitiveInsights.length).toBeGreaterThanOrEqual(1);

    const insight = repetitiveInsights[0];
    expect(insight.entity).toBe("purchase_request");
    expect(insight.confidence).toBeGreaterThanOrEqual(0.7);
    expect(insight.evidence.count).toBeGreaterThanOrEqual(5);
    expect(insight.suggestedAction.type).toBe("add_rule");
  });

  test("detects default value pattern", async () => {
    // All orders have currency = "USD"
    for (let i = 0; i < 8; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { amount: (i + 1) * 100, currency: "USD", customer: `customer-${i}` },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.8,
    });
    const insights = await detector.analyze(logger);

    const defaultInsights = insights.filter((i) => i.type === "default_value");
    expect(defaultInsights.length).toBeGreaterThanOrEqual(1);

    // Should detect "currency" = "USD" as a default
    const currencyInsight = defaultInsights.find((i) => i.description.includes("currency"));
    expect(currencyInsight).toBeDefined();
    expect(currencyInsight?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(currencyInsight?.suggestedAction.type).toBe("modify_schema");
    expect(currencyInsight?.suggestedAction.details.field).toBe("currency");
    expect(currencyInsight?.suggestedAction.details.defaultValue).toBe("USD");
  });

  test("detects validation pattern (email format)", async () => {
    // All records have a field that consistently looks like emails
    for (let i = 0; i < 8; i++) {
      await logger.log(
        createLog({
          action: "create_contact",
          entity: "contact",
          input: { email: `user${i}@example.com`, name: `User ${i}` },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.7,
    });
    const insights = await detector.analyze(logger);

    const validationInsights = insights.filter((i) => i.type === "validation_pattern");
    expect(validationInsights.length).toBeGreaterThanOrEqual(1);

    const emailPattern = validationInsights.find((i) => i.description.includes("email"));
    expect(emailPattern).toBeDefined();
    expect(emailPattern?.suggestedAction.type).toBe("add_rule");
  });

  test("detects state flow pattern", async () => {
    // Simulate 8 records going through draft → submitted → approved
    for (let i = 0; i < 8; i++) {
      const recordId = `rec-${i}`;
      const baseDate = daysAgo(10 - i);

      // Transition: draft → submitted
      await logger.log(
        createLog({
          action: "submit",
          entity: "request",
          recordId,
          stateTransition: { from: "draft", to: "submitted" },
          startedAt: new Date(baseDate.getTime()),
        }),
      );

      // Transition: submitted → approved
      await logger.log(
        createLog({
          action: "approve",
          entity: "request",
          recordId,
          stateTransition: { from: "submitted", to: "approved" },
          startedAt: new Date(baseDate.getTime() + 3600000),
        }),
      );
    }

    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.7,
    });
    const insights = await detector.analyze(logger);

    const flowInsights = insights.filter((i) => i.type === "state_flow");
    expect(flowInsights.length).toBeGreaterThanOrEqual(1);

    const flow = flowInsights[0];
    expect(flow.entity).toBe("request");
    expect(flow.description).toContain("draft");
    expect(flow.description).toContain("approved");
    expect(flow.suggestedAction.type).toBe("add_automation");
  });

  test("detects timing pattern (hour concentration)", async () => {
    // All actions happen between 9:00-10:00
    for (let i = 0; i < 10; i++) {
      const d = daysAgo(i);
      d.setHours(9, Math.floor(Math.random() * 60), 0, 0);
      await logger.log(
        createLog({
          action: "daily_review",
          entity: "task",
          input: { type: "review" },
          startedAt: d,
        }),
      );
    }

    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.7,
    });
    const insights = await detector.analyze(logger);

    const timingInsights = insights.filter((i) => i.type === "timing");
    expect(timingInsights.length).toBeGreaterThanOrEqual(1);

    const hourInsight = timingInsights.find((i) => i.description.includes("9:00"));
    expect(hourInsight).toBeDefined();
    expect(hourInsight?.suggestedAction.type).toBe("add_automation");
  });
});

// ── analyzeSchema — schema-scoped analysis ───────────────

describe("PatternDetector.analyzeSchema", () => {
  let logger: InMemoryExecutionLogger;

  beforeEach(() => {
    logger = new InMemoryExecutionLogger();
  });

  test("only analyzes logs for the specified schema", async () => {
    // Logs from two different schemas
    for (let i = 0; i < 8; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD", amount: 100 },
          startedAt: daysAgo(i),
        }),
      );
      await logger.log(
        createLog({
          action: "create_product",
          entity: "product",
          input: { name: `Product ${i}`, price: i * 10 },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
    const insights = await detector.analyzeSchema(logger, "order");

    // Should only contain insights about "order"
    for (const insight of insights) {
      expect(insight.entity).toBe("order");
    }
  });

  test("returns empty when schema has no logs", async () => {
    const detector = new PatternDetector();
    const insights = await detector.analyzeSchema(logger, "nonexistent");
    expect(insights).toHaveLength(0);
  });
});

// ── Configuration tests ─────────────────────────────────

describe("PatternDetector — configuration", () => {
  let logger: InMemoryExecutionLogger;

  beforeEach(() => {
    logger = new InMemoryExecutionLogger();
  });

  test("respects minOccurrences threshold", async () => {
    // Only 3 logs — below the default minOccurrences of 5
    for (let i = 0; i < 3; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD" },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5 });
    const insights = await detector.analyze(logger);
    expect(insights).toHaveLength(0);
  });

  test("respects minConfidence threshold", async () => {
    // Mix of values — low confidence
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: i < 5 ? "USD" : `OTHER-${i}` },
          startedAt: daysAgo(i),
        }),
      );
    }

    // 50% is below 0.8 confidence
    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.8 });
    const insights = await detector.analyze(logger);
    const defaultInsights = insights.filter((i) => i.type === "default_value");
    const currencyInsight = defaultInsights.find((i) => i.description.includes("currency"));
    // 50% confidence should be filtered out at 0.8 threshold
    expect(currencyInsight).toBeUndefined();
  });

  test("enables only specific pattern types", async () => {
    for (let i = 0; i < 8; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD" },
          startedAt: daysAgo(i),
        }),
      );
    }

    // Only enable timing — should NOT detect default_value
    const detector = new PatternDetector({
      minOccurrences: 5,
      minConfidence: 0.7,
      enabledPatterns: ["timing"],
    });
    const insights = await detector.analyze(logger);
    const defaultInsights = insights.filter((i) => i.type === "default_value");
    expect(defaultInsights).toHaveLength(0);
  });

  test("insights are sorted by confidence descending", async () => {
    // Create logs that produce multiple insights with different confidence levels
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "process_payment",
          entity: "payment",
          actor: { type: "user", id: "user-1", groups: [] },
          input: {
            currency: "USD", // 100% frequency
            method: i < 8 ? "card" : "cash", // 80% frequency
          },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
    const insights = await detector.analyze(logger);

    // Check that insights are sorted by confidence descending
    for (let i = 1; i < insights.length; i++) {
      expect(insights[i - 1].confidence).toBeGreaterThanOrEqual(insights[i].confidence);
    }
  });
});

// ── Edge cases ──────────────────────────────────────────

describe("PatternDetector — edge cases", () => {
  let logger: InMemoryExecutionLogger;

  beforeEach(() => {
    logger = new InMemoryExecutionLogger();
  });

  test("ignores failed execution logs", async () => {
    // Only failed logs — should not produce insights
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD" },
          status: "failed",
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
    const insights = await detector.analyze(logger);
    // analyze() filters by status: "succeeded", so failed logs are excluded
    expect(insights).toHaveLength(0);
  });

  test("ignores logs outside lookback window", async () => {
    // All logs are 60 days old — outside default 30 day lookback
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD" },
          startedAt: daysAgo(60 + i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, lookbackDays: 30 });
    const insights = await detector.analyze(logger);
    expect(insights).toHaveLength(0);
  });

  test("handles logs with object values in input (skips them)", async () => {
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: {
            metadata: { nested: "value" }, // object — should be skipped
            currency: "USD", // primitive — should be detected
          },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
    const insights = await detector.analyze(logger);

    // Should detect currency default but NOT metadata (object values ignored)
    const defaultInsights = insights.filter((i) => i.type === "default_value");
    const metadataInsight = defaultInsights.find((i) => i.description.includes("metadata"));
    expect(metadataInsight).toBeUndefined();
  });

  test("unique insight IDs", async () => {
    for (let i = 0; i < 10; i++) {
      await logger.log(
        createLog({
          action: "create_order",
          entity: "order",
          input: { currency: "USD", region: "US" },
          startedAt: daysAgo(i),
        }),
      );
    }

    const detector = new PatternDetector({ minOccurrences: 5, minConfidence: 0.7 });
    const insights = await detector.analyze(logger);

    const ids = insights.map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
