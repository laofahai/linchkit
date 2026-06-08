/**
 * Tests for the pure helpers behind SchedulerStatusPanel: the ms humanizer, the
 * response → view-state reducer, the error-streak predicate, and the timestamp
 * formatter. No DOM / render — logic only, mirroring the repo's UI test style.
 */

import { describe, expect, test } from "bun:test";
import {
  formatTimestamp,
  hasErrorStreak,
  humanizeMs,
  toSchedulerStatusView,
} from "../src/components/scheduler-status-panel-helpers";
import type { SchedulerStatusResult } from "../src/lib/evolution-api";

// ── humanizeMs ─────────────────────────────────────────────

describe("humanizeMs", () => {
  test("returns a dash for null / undefined / negative / non-finite", () => {
    expect(humanizeMs(null)).toBe("—");
    expect(humanizeMs(undefined)).toBe("—");
    expect(humanizeMs(-1)).toBe("—");
    expect(humanizeMs(Number.NaN)).toBe("—");
    expect(humanizeMs(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("formats sub-second as ms", () => {
    expect(humanizeMs(0)).toBe("0ms");
    expect(humanizeMs(250)).toBe("250ms");
    expect(humanizeMs(999)).toBe("999ms");
  });

  test("formats sub-minute as seconds, dropping a trailing .0", () => {
    expect(humanizeMs(1000)).toBe("1s");
    expect(humanizeMs(1500)).toBe("1.5s");
    expect(humanizeMs(59000)).toBe("59s");
  });

  test("formats minutes, with optional remaining seconds", () => {
    expect(humanizeMs(60000)).toBe("1m");
    expect(humanizeMs(300000)).toBe("5m");
    expect(humanizeMs(90000)).toBe("1m 30s");
  });

  test("formats hours, with optional remaining minutes", () => {
    expect(humanizeMs(3600000)).toBe("1h");
    expect(humanizeMs(5400000)).toBe("1h 30m");
  });
});

// ── toSchedulerStatusView ──────────────────────────────────

describe("toSchedulerStatusView", () => {
  test("disabled tone for ok + configured:false", () => {
    const result: SchedulerStatusResult = { kind: "ok", status: { configured: false } };
    const view = toSchedulerStatusView(result);
    expect(view.tone).toBe("disabled");
    expect(view.labelDefault).toBe("Disabled");
    expect(view.detail).toBeUndefined();
  });

  test("running tone for ok + configured:true + running:true", () => {
    const result: SchedulerStatusResult = {
      kind: "ok",
      status: {
        configured: true,
        running: true,
        intervalMs: 300000,
        ticksStarted: 3,
        ticksCompleted: 3,
        lastTickStartedAt: "2026-06-08T10:00:00.000Z",
        lastTickCompletedAt: "2026-06-08T10:00:01.000Z",
        lastTickDurationMs: 1000,
        lastError: null,
        consecutiveErrors: 0,
      },
    };
    const view = toSchedulerStatusView(result);
    expect(view.tone).toBe("running");
    expect(view.labelDefault).toBe("Running");
    expect(view.detail?.intervalMs).toBe(300000);
    expect(view.detail?.ticksCompleted).toBe(3);
  });

  test("idle tone for ok + configured:true + running:false", () => {
    const result: SchedulerStatusResult = {
      kind: "ok",
      status: {
        configured: true,
        running: false,
        intervalMs: 300000,
        ticksStarted: 0,
        ticksCompleted: 0,
        lastTickStartedAt: null,
        lastTickCompletedAt: null,
        lastTickDurationMs: null,
        lastError: null,
        consecutiveErrors: 0,
      },
    };
    const view = toSchedulerStatusView(result);
    expect(view.tone).toBe("idle");
    expect(view.labelDefault).toBe("Idle");
    expect(view.detail?.running).toBe(false);
  });

  test("denied tone for a denied result", () => {
    const view = toSchedulerStatusView({ kind: "denied" });
    expect(view.tone).toBe("denied");
    expect(view.labelDefault).toBe("Unauthorized");
    expect(view.detail).toBeUndefined();
  });

  test("error tone carries the message", () => {
    const view = toSchedulerStatusView({ kind: "error", message: "Command layer not configured." });
    expect(view.tone).toBe("error");
    expect(view.labelDefault).toBe("Unavailable");
    expect(view.message).toBe("Command layer not configured.");
  });
});

// ── hasErrorStreak ─────────────────────────────────────────

describe("hasErrorStreak", () => {
  const base = {
    running: false,
    intervalMs: 0,
    ticksStarted: 0,
    ticksCompleted: 0,
    lastTickStartedAt: null,
    lastTickCompletedAt: null,
    lastTickDurationMs: null,
    lastError: null,
  };

  test("false for undefined detail", () => {
    expect(hasErrorStreak(undefined)).toBe(false);
  });

  test("false when consecutiveErrors is 0", () => {
    expect(hasErrorStreak({ ...base, consecutiveErrors: 0 })).toBe(false);
  });

  test("true when consecutiveErrors > 0", () => {
    expect(hasErrorStreak({ ...base, consecutiveErrors: 2, lastError: "boom" })).toBe(true);
  });
});

// ── formatTimestamp ────────────────────────────────────────

describe("formatTimestamp", () => {
  test("returns a dash for null / undefined / empty / invalid", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
    expect(formatTimestamp("not-a-date")).toBe("—");
  });

  test("returns a non-dash localized string for a valid ISO timestamp", () => {
    const out = formatTimestamp("2026-06-08T10:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });
});
