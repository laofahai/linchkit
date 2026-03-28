import { describe, expect, it, mock } from "bun:test";
import type { AnomalyDetection, UsageEvent } from "../src/ai/anomaly-detector";
import { AnomalyDetector } from "../src/ai/anomaly-detector";

// ── Helpers ────────────────────────────────────────────────────

/** Create a usage event at a relative time offset (ms from now) */
function event(opts: {
  offsetMs?: number;
  success?: boolean;
  actionName?: string;
  tenantId?: string;
  actorId?: string;
  cost?: number;
  tokens?: number;
}): UsageEvent {
  return {
    timestamp: new Date(Date.now() - (opts.offsetMs ?? 0)),
    success: opts.success ?? true,
    actionName: opts.actionName,
    tenantId: opts.tenantId,
    actorId: opts.actorId,
    cost: opts.cost,
    tokens: opts.tokens,
  };
}

/** Fill the detector with baseline events spread over time */
function buildBaseline(detector: AnomalyDetector, eventCount: number, windowMs: number): void {
  // Simulate 5 baseline windows to establish a rate
  for (let w = 0; w < 5; w++) {
    for (let i = 0; i < eventCount; i++) {
      detector.recordEvent(event({ offsetMs: windowMs * (w + 1) + i * 10, actionName: "query" }));
    }
    detector.detect();
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe("AnomalyDetector", () => {
  describe("request spike detection", () => {
    it("detects spike when current rate exceeds baseline * multiplier", () => {
      const windowMs = 60_000; // 1 minute window for faster test
      const detector = new AnomalyDetector({
        windowSizeMs: windowMs,
        spikeMultiplier: 2.0,
        minEventsForDetection: 5,
      });

      // Build a baseline of ~10 events per window
      buildBaseline(detector, 10, windowMs);

      // Now add a spike of 30 events in current window
      for (let i = 0; i < 30; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, actionName: "query" }));
      }

      const anomalies = detector.detect();
      const spike = anomalies.find((a) => a.type === "request_spike");
      expect(spike).toBeDefined();
      // Severity depends on how far above threshold — critical when > 2x threshold
      expect(["alert", "critical"]).toContain(spike?.severity);
    });

    it("does not fire spike before baseline is established", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        spikeMultiplier: 2.0,
        minEventsForDetection: 5,
      });

      // Add events but don't build baseline (< 3 windows observed)
      for (let i = 0; i < 20; i++) {
        detector.recordEvent(event({ offsetMs: i * 10 }));
      }

      const anomalies = detector.detect();
      expect(anomalies.find((a) => a.type === "request_spike")).toBeUndefined();
    });
  });

  describe("high error rate detection", () => {
    it("detects when error rate exceeds threshold", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        errorRateThreshold: 0.5,
        minEventsForDetection: 5,
      });

      // 8 failures out of 10 events = 80% error rate
      for (let i = 0; i < 8; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, success: false }));
      }
      for (let i = 0; i < 2; i++) {
        detector.recordEvent(event({ offsetMs: 100 + i * 10, success: true }));
      }

      const anomalies = detector.detect();
      const errorAnomaly = anomalies.find((a) => a.type === "high_error_rate");
      expect(errorAnomaly).toBeDefined();
      expect(errorAnomaly?.severity).toBe("critical"); // 80% >= 80%
      expect(errorAnomaly?.metrics.errorRate).toBeCloseTo(0.8, 1);
    });

    it("does not fire when error rate is below threshold", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        errorRateThreshold: 0.5,
        minEventsForDetection: 5,
      });

      // 2 failures out of 10 = 20%
      for (let i = 0; i < 2; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, success: false }));
      }
      for (let i = 0; i < 8; i++) {
        detector.recordEvent(event({ offsetMs: 100 + i * 10, success: true }));
      }

      const anomalies = detector.detect();
      expect(anomalies.find((a) => a.type === "high_error_rate")).toBeUndefined();
    });
  });

  describe("repetitive action detection", () => {
    it("detects same action called too many times", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        repetitiveActionThreshold: 10,
        minEventsForDetection: 5,
      });

      for (let i = 0; i < 15; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, actionName: "create_order" }));
      }

      const anomalies = detector.detect();
      const repetitive = anomalies.find((a) => a.type === "repetitive_action");
      expect(repetitive).toBeDefined();
      expect(repetitive?.description).toContain("create_order");
      expect(repetitive?.description).toContain("15");
    });

    it("does not fire for diverse actions", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        repetitiveActionThreshold: 10,
        minEventsForDetection: 5,
      });

      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, actionName: `action_${i}` }));
      }

      const anomalies = detector.detect();
      expect(anomalies.find((a) => a.type === "repetitive_action")).toBeUndefined();
    });
  });

  describe("diverse action burst detection", () => {
    it("detects too many distinct actions in a window", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        diverseActionThreshold: 10,
        minEventsForDetection: 5,
      });

      for (let i = 0; i < 15; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, actionName: `action_${i}` }));
      }

      const anomalies = detector.detect();
      const diverse = anomalies.find((a) => a.type === "diverse_action_burst");
      expect(diverse).toBeDefined();
      expect(diverse?.metrics.distinctActions).toBe(15);
    });
  });

  describe("off-hours activity detection", () => {
    it("does not detect off-hours by default", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 5,
        // detectOffHours defaults to false
      });

      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10 }));
      }

      const anomalies = detector.detect();
      expect(anomalies.find((a) => a.type === "off_hours_activity")).toBeUndefined();
    });

    it("detects off-hours activity when enabled", () => {
      const hour = new Date().getHours();
      // Set business hours to exclude current hour
      const start = (hour + 2) % 24;
      const end = (hour + 1) % 24;

      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 5,
        detectOffHours: true,
        businessHoursStart: start,
        businessHoursEnd: end === 0 ? 24 : end, // Ensure end > start for the test
      });

      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10 }));
      }

      const anomalies = detector.detect();
      const offHours = anomalies.find((a) => a.type === "off_hours_activity");
      // This depends on current time — if current hour is outside [start, end), it should detect
      expect(offHours).toBeDefined();
    });
  });

  describe("budget burn rate detection", () => {
    it("detects high hourly burn rate", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000, // 1 minute window
        minEventsForDetection: 5,
        budgetBurnRateThreshold: 0.1, // Low threshold for test
      });

      // Add events with high cost
      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, cost: 5.0 }));
      }

      const anomalies = detector.detect();
      const burn = anomalies.find((a) => a.type === "budget_burn_rate");
      expect(burn).toBeDefined();
      expect(burn?.metrics.totalCost).toBe(50);
    });
  });

  describe("tenant/actor filtering", () => {
    it("filters anomaly detection by tenantId", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 5,
        errorRateThreshold: 0.5,
      });

      // tenant-1: all failures
      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, tenantId: "tenant-1", success: false }));
      }
      // tenant-2: all successes
      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, tenantId: "tenant-2", success: true }));
      }

      const t1 = detector.detect({ tenantId: "tenant-1" });
      expect(t1.find((a) => a.type === "high_error_rate")).toBeDefined();

      const t2 = detector.detect({ tenantId: "tenant-2" });
      expect(t2.find((a) => a.type === "high_error_rate")).toBeUndefined();
    });
  });

  describe("onAnomaly callback", () => {
    it("fires callback for each detected anomaly", () => {
      const cb = mock((_a: AnomalyDetection) => {});
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 5,
        errorRateThreshold: 0.3,
        onAnomaly: cb,
      });

      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, success: false }));
      }

      detector.detect();
      expect(cb).toHaveBeenCalled();
    });
  });

  describe("buffer management", () => {
    it("trims buffer when exceeding max size", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 1,
      });

      // Add more events than MAX_BUFFER (10,000)
      for (let i = 0; i < 10_500; i++) {
        detector.recordEvent(event({ offsetMs: i }));
      }

      // Buffer should be trimmed but still have events
      expect(detector.getEventCount()).toBeLessThan(10_500);
      expect(detector.getEventCount()).toBeGreaterThan(0);
    });
  });

  describe("clear", () => {
    it("resets all state", () => {
      const detector = new AnomalyDetector({ windowSizeMs: 60_000 });

      for (let i = 0; i < 10; i++) {
        detector.recordEvent(event({ offsetMs: i * 10 }));
      }

      detector.clear();
      expect(detector.getEventCount()).toBe(0);
      expect(detector.getBaselineRate()).toBe(0);
    });
  });

  describe("min events threshold", () => {
    it("skips detection when below min events", () => {
      const detector = new AnomalyDetector({
        windowSizeMs: 60_000,
        minEventsForDetection: 20,
        errorRateThreshold: 0.1,
      });

      // Only 5 events, all failures — should NOT trigger anomaly
      for (let i = 0; i < 5; i++) {
        detector.recordEvent(event({ offsetMs: i * 10, success: false }));
      }

      const anomalies = detector.detect();
      expect(anomalies).toHaveLength(0);
    });
  });
});
