/**
 * Tests for the shared formatRelativeTime helper.
 *
 * Inputs are constructed relative to Date.now() with comfortable margins
 * around each unit boundary so a slow test run cannot flip a bucket.
 */

import { describe, expect, test } from "bun:test";
import { formatRelativeTime, type RelativeTimeTranslator } from "../src/lib/format-relative-time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("formatRelativeTime (default English translator)", () => {
  test("under a minute renders 'just now'", () => {
    expect(formatRelativeTime(isoAgo(0))).toBe("just now");
    expect(formatRelativeTime(isoAgo(30_000))).toBe("just now");
  });

  test("minute boundary: 61s renders '1m ago'", () => {
    expect(formatRelativeTime(isoAgo(61_000))).toBe("1m ago");
  });

  test("under an hour renders minutes", () => {
    expect(formatRelativeTime(isoAgo(5 * MINUTE))).toBe("5m ago");
    expect(formatRelativeTime(isoAgo(59 * MINUTE))).toBe("59m ago");
  });

  test("hour boundary: 61m renders '1h ago'", () => {
    expect(formatRelativeTime(isoAgo(61 * MINUTE))).toBe("1h ago");
  });

  test("under a day renders hours", () => {
    expect(formatRelativeTime(isoAgo(23 * HOUR))).toBe("23h ago");
  });

  test("day boundary: 25h renders '1d ago'", () => {
    expect(formatRelativeTime(isoAgo(25 * HOUR))).toBe("1d ago");
  });

  test("under 30 days renders days", () => {
    expect(formatRelativeTime(isoAgo(29 * DAY))).toBe("29d ago");
  });

  test("30 days and older falls back to the locale date", () => {
    const iso = isoAgo(45 * DAY);
    expect(formatRelativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  test("future timestamps render 'just now'", () => {
    expect(formatRelativeTime(isoAgo(-10_000))).toBe("just now");
  });
});

describe("formatRelativeTime (custom translator)", () => {
  /** Recording translator that captures the key/options it was called with. */
  function makeRecorder() {
    const calls: Array<{ key: string; options?: Record<string, unknown> }> = [];
    const t: RelativeTimeTranslator = (key, options) => {
      calls.push({ key, options });
      return `<${key}>`;
    };
    return { calls, t };
  }

  test("passes the time.justNow key", () => {
    const { calls, t } = makeRecorder();
    expect(formatRelativeTime(isoAgo(10_000), t)).toBe("<time.justNow>");
    expect(calls[0]).toEqual({
      key: "time.justNow",
      options: { defaultValue: "just now" },
    });
  });

  test("passes the time.minutesAgo key with count", () => {
    const { calls, t } = makeRecorder();
    expect(formatRelativeTime(isoAgo(5 * MINUTE), t)).toBe("<time.minutesAgo>");
    expect(calls[0]).toEqual({
      key: "time.minutesAgo",
      options: { defaultValue: "{{count}}m ago", count: 5 },
    });
  });

  test("passes the time.hoursAgo key with count", () => {
    const { calls, t } = makeRecorder();
    expect(formatRelativeTime(isoAgo(3 * HOUR), t)).toBe("<time.hoursAgo>");
    expect(calls[0]).toEqual({
      key: "time.hoursAgo",
      options: { defaultValue: "{{count}}h ago", count: 3 },
    });
  });

  test("passes the time.daysAgo key with count", () => {
    const { calls, t } = makeRecorder();
    expect(formatRelativeTime(isoAgo(7 * DAY), t)).toBe("<time.daysAgo>");
    expect(calls[0]).toEqual({
      key: "time.daysAgo",
      options: { defaultValue: "{{count}}d ago", count: 7 },
    });
  });

  test("does not call the translator for >=30d old timestamps", () => {
    const { calls, t } = makeRecorder();
    const iso = isoAgo(45 * DAY);
    expect(formatRelativeTime(iso, t)).toBe(new Date(iso).toLocaleDateString());
    expect(calls).toHaveLength(0);
  });

  test("renders empty string for falsy or unparseable input", () => {
    const { calls, t } = makeRecorder();
    expect(formatRelativeTime(null, t)).toBe("");
    expect(formatRelativeTime(undefined, t)).toBe("");
    expect(formatRelativeTime("", t)).toBe("");
    expect(formatRelativeTime("not-a-date", t)).toBe("");
    expect(calls).toHaveLength(0);
  });
});
