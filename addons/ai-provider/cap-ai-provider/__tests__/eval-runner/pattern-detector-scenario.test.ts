/**
 * Tests for the pattern-detector scenario adapter.
 *
 * Deterministic (no LLM). Verifies correct wiring of PatternDetector,
 * field mapping (timestamp → startedAt), and output serialisation.
 */

import { describe, expect, it } from "bun:test";
import type {
  EvalFixture,
  PatternEvalOutput,
  PatternFixtureContext,
  PatternFixtureInput,
} from "@linchkit/devtools";
import { createPatternDetectorScenario } from "../../eval-runner/pattern-detector-scenario";

function makeEntry(
  id: string,
  overrides: {
    action?: string;
    entity?: string;
    actorId?: string;
    input?: Record<string, unknown>;
    timestamp?: string;
  } = {},
) {
  return {
    id,
    action: overrides.action ?? "create_order",
    entity: overrides.entity ?? "order",
    status: "succeeded" as const,
    input: overrides.input ?? { currency: "USD", amount: 100 },
    actor: { id: overrides.actorId ?? "user-alice", type: "user" },
    timestamp: overrides.timestamp ?? "2026-05-20T10:00:00Z",
  };
}

function makeFixture(
  id: string,
  input: PatternFixtureInput,
  context?: PatternFixtureContext,
): EvalFixture<PatternFixtureInput, PatternFixtureContext> {
  return {
    id,
    scenario: "pattern-detector",
    tags: ["test"],
    description: id,
    input,
    context,
    expected: { matchers: [] },
  };
}

describe("createPatternDetectorScenario.runLive", () => {
  const scenario = createPatternDetectorScenario();

  it("returns empty array when entries < minOccurrences", async () => {
    const fx = makeFixture("too-few", {
      entries: [makeEntry("e1"), makeEntry("e2"), makeEntry("e3")],
      config: { minOccurrences: 5 },
    });
    const out = await scenario.runLive(fx);
    expect(out).toEqual([]);
  });

  it("detects default_value pattern when a field is always the same", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry(`e${i}`, {
        entity: "order",
        action: "create_order",
        actorId: "user-alice",
        input: { currency: "USD", amount: i * 100 + 100 },
        timestamp: `2026-05-${20 + i}T10:00:00Z`,
      }),
    );

    const fx = makeFixture("default-value", {
      entries,
      config: { minOccurrences: 5, minConfidence: 0.7 },
    });
    const out = await scenario.runLive(fx);
    // currency is always "USD" → should detect default_value pattern
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((p) => p.type === "default_value")).toBe(true);
  });

  it("detects repetitive_action pattern when actor repeats action with same field value", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry(`e${i}`, {
        action: "approve_order",
        entity: "order",
        actorId: "user-bob",
        input: { status: "VIP", orderId: `ord-${i}` },
        timestamp: `2026-05-${18 + i}T10:00:00Z`,
      }),
    );

    const fx = makeFixture("repetitive", {
      entries,
      config: { minOccurrences: 5, minConfidence: 0.7 },
    });
    const out = await scenario.runLive(fx);
    expect(out.some((p) => p.type === "repetitive_action")).toBe(true);
  });

  it("output items have required serialisable fields", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry(`e${i}`, {
        entity: "order",
        input: { currency: "USD", amount: i * 50 },
        timestamp: `2026-05-${20 + i}T10:00:00Z`,
      }),
    );
    const fx = makeFixture("fields", {
      entries,
      config: { minOccurrences: 5, minConfidence: 0.7 },
    });
    const out = await scenario.runLive(fx);
    if (out.length > 0) {
      const item = out[0] as PatternEvalOutput[0];
      expect(typeof item.id).toBe("string");
      expect(typeof item.type).toBe("string");
      expect(typeof item.entity).toBe("string");
      expect(typeof item.description).toBe("string");
      expect(typeof item.confidence).toBe("number");
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(typeof item.evidence).toBe("object");
      expect(typeof item.evidence.count).toBe("number");
    }
  });

  it("returns no patterns when inputs are too diverse (no field dominates)", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry(`e${i}`, {
        entity: "order",
        actorId: "user-alice",
        input: { currency: ["USD", "EUR", "GBP", "JPY", "CNY", "CHF"][i], amount: i * 100 },
        timestamp: `2026-05-${20 + i}T10:00:00Z`,
      }),
    );
    const fx = makeFixture("diverse", {
      entries,
      config: { minOccurrences: 5, minConfidence: 0.9 },
    });
    const out = await scenario.runLive(fx);
    // No single currency dominates at 90% confidence
    expect(out.every((p) => p.type !== "default_value")).toBe(true);
  });
});

describe("createPatternDetectorScenario.replayFromBaseline", () => {
  const scenario = createPatternDetectorScenario();

  it("produces same result as runLive (deterministic adapter)", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry(`e${i}`, {
        entity: "order",
        input: { currency: "USD", amount: i * 100 },
        timestamp: `2026-05-${20 + i}T10:00:00Z`,
      }),
    );
    const fx = makeFixture("replay", {
      entries,
      config: { minOccurrences: 5, minConfidence: 0.7 },
    });
    const live = await scenario.runLive(fx);
    const replayed = await scenario.replayFromBaseline(fx, undefined);
    // PatternDetector uses Date.now() for insight IDs, so IDs differ across calls.
    // Verify structural equivalence (same types, entities, confidence) instead.
    const strip = (items: typeof live) => items.map(({ id: _, ...rest }) => rest);
    expect(strip(replayed)).toEqual(strip(live));
  });
});
