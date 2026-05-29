/**
 * Tests for the anomaly-detector scenario adapter.
 *
 * The adapter is deterministic (no LLM). Tests verify that the adapter
 * correctly wires AnomalyDetector and returns serialisable output.
 *
 * Note: AnomalyDetector.windowSizeMs defaults to 300_000ms (5 min).
 * All tests pass windowSizeMs explicitly to keep events in-window.
 */

import { describe, expect, it } from "bun:test";
import type {
  AnomalyEvalOutput,
  AnomalyFixtureContext,
  AnomalyFixtureInput,
  EvalFixture,
} from "@linchkit/devtools";
import { createAnomalyDetectorScenario } from "../../eval-runner/anomaly-detector-scenario";

const NOW = "2026-05-24T10:00:00Z";
// 10-minute window — all events spaced 30s apart fit within this
const WINDOW_MS = 600_000;

function makeFixture(
  id: string,
  input: AnomalyFixtureInput,
  context?: AnomalyFixtureContext,
): EvalFixture<AnomalyFixtureInput, AnomalyFixtureContext> {
  return {
    id,
    scenario: "anomaly-detector",
    tags: ["test"],
    description: id,
    input,
    context,
    expected: { matchers: [] },
  };
}

// Build N events spaced 30s apart, all within the 10-min window
function makeEvents(
  n: number,
  opts: { success?: boolean; cost?: number; actionName?: string } = {},
) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(new Date(NOW).getTime() - i * 30_000).toISOString(),
    success: opts.success ?? true,
    cost: opts.cost ?? 0.01,
    actionName: opts.actionName ?? "test_action",
  }));
}

describe("createAnomalyDetectorScenario.runLive", () => {
  const scenario = createAnomalyDetectorScenario();

  it("returns empty array when event count < minEventsForDetection", async () => {
    const fx = makeFixture(
      "too-few",
      {
        events: makeEvents(5),
        config: { minEventsForDetection: 10, windowSizeMs: WINDOW_MS },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out).toEqual([]);
  });

  it("returns empty array for healthy traffic at or above minEventsForDetection", async () => {
    const fx = makeFixture(
      "healthy",
      {
        events: makeEvents(12),
        config: { minEventsForDetection: 10, windowSizeMs: WINDOW_MS },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out).toEqual([]);
  });

  it("detects high_error_rate when error rate >= threshold", async () => {
    const now = new Date(NOW);
    // 10 events, 4 succeed (i<4), 6 fail → 60% error rate (> 50% threshold)
    const events = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(now.getTime() - i * 30_000).toISOString(),
      success: i < 4,
      cost: 0.01,
      actionName: "test_action",
    }));

    const fx = makeFixture(
      "error-rate",
      {
        events,
        config: { minEventsForDetection: 10, errorRateThreshold: 0.5, windowSizeMs: WINDOW_MS },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((a) => a.type === "high_error_rate")).toBe(true);
  });

  it("detects repetitive_action when single action >= threshold", async () => {
    const now = new Date(NOW);
    // 15 events all with same actionName, threshold=10 → fires
    const events = Array.from({ length: 15 }, (_, i) => ({
      timestamp: new Date(now.getTime() - i * 20_000).toISOString(),
      success: true,
      cost: 0.01,
      actionName: "spam_action",
    }));

    const fx = makeFixture(
      "repetitive",
      {
        events,
        config: {
          minEventsForDetection: 10,
          repetitiveActionThreshold: 10,
          windowSizeMs: WINDOW_MS,
        },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out.some((a) => a.type === "repetitive_action")).toBe(true);
  });

  it("detects diverse_action_burst when distinct action count >= threshold", async () => {
    const now = new Date(NOW);
    // 15 events each with unique actionName → 15 distinct actions, threshold=10
    const events = Array.from({ length: 15 }, (_, i) => ({
      timestamp: new Date(now.getTime() - i * 20_000).toISOString(),
      success: true,
      cost: 0.01,
      actionName: `action_${i}`,
    }));

    const fx = makeFixture(
      "diverse",
      {
        events,
        config: {
          minEventsForDetection: 10,
          diverseActionThreshold: 10,
          windowSizeMs: WINDOW_MS,
        },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out.some((a) => a.type === "diverse_action_burst")).toBe(true);
  });

  it("output items have required serialisable fields", async () => {
    const now = new Date(NOW);
    // 10 events: 4 succeed, 6 fail → 60% error rate triggers anomaly
    const events = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(now.getTime() - i * 30_000).toISOString(),
      success: i < 4,
      cost: 0.01,
    }));

    const fx = makeFixture(
      "fields",
      {
        events,
        config: { minEventsForDetection: 10, errorRateThreshold: 0.5, windowSizeMs: WINDOW_MS },
      },
      { now: NOW },
    );
    const out = await scenario.runLive(fx);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const item = out[0] as AnomalyEvalOutput[0];
    expect(typeof item.type).toBe("string");
    expect(typeof item.severity).toBe("string");
    expect(typeof item.description).toBe("string");
    expect(typeof item.metrics).toBe("object");
    expect(typeof item.thresholds).toBe("object");
  });

  it("filters by tenantId when context.tenantId is set", async () => {
    const now = new Date(NOW);
    const events = [
      // tenant-A: 8 events within window, 6 errors → 75% error rate
      ...Array.from({ length: 8 }, (_, i) => ({
        timestamp: new Date(now.getTime() - i * 30_000).toISOString(),
        success: i < 2,
        tenantId: "tenant-A",
        actionName: "test",
      })),
      // tenant-B: 5 healthy events
      ...Array.from({ length: 5 }, (_, i) => ({
        timestamp: new Date(now.getTime() - i * 30_000).toISOString(),
        success: true,
        tenantId: "tenant-B",
        actionName: "test",
      })),
    ];

    const fx = makeFixture(
      "tenant-filter",
      {
        events,
        config: { minEventsForDetection: 5, errorRateThreshold: 0.5, windowSizeMs: WINDOW_MS },
      },
      { now: NOW, tenantId: "tenant-A" },
    );
    const out = await scenario.runLive(fx);
    expect(out.some((a) => a.type === "high_error_rate")).toBe(true);
  });
});

describe("createAnomalyDetectorScenario.replayFromBaseline", () => {
  const scenario = createAnomalyDetectorScenario();

  it("produces the same result as runLive (deterministic adapter)", async () => {
    const now = new Date(NOW);
    const events = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(now.getTime() - i * 30_000).toISOString(),
      success: i < 4,
      cost: 0.01,
    }));

    const fx = makeFixture(
      "replay",
      {
        events,
        config: { minEventsForDetection: 10, errorRateThreshold: 0.5, windowSizeMs: WINDOW_MS },
      },
      { now: NOW },
    );
    const live = await scenario.runLive(fx);
    const replayed = await scenario.replayFromBaseline(fx, null);
    expect(replayed).toEqual(live);
  });
});
