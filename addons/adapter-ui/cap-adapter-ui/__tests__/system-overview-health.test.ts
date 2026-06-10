/**
 * normalizeHealthChecks — the /health endpoint has three live shapes
 * (adapter-server routes/health.ts); the System Overview page must render
 * all of them without crashing ("health.checks.map is not a function" was
 * thrown on the minimal object map).
 */

import { describe, expect, test } from "bun:test";
import { normalizeHealthChecks } from "../src/pages/system-overview";

describe("normalizeHealthChecks", () => {
  test("minimal object map (the live crash case) becomes one check per entry", () => {
    const checks = normalizeHealthChecks({ process: { ok: true } });
    expect(checks).toEqual([{ name: "process", status: "healthy", durationMs: 0 }]);
  });

  test("object map entry with ok=false maps to unhealthy", () => {
    const checks = normalizeHealthChecks({ database: { ok: false, detail: "connect refused" } });
    expect(checks).toEqual([
      { name: "database", status: "unhealthy", message: "connect refused", durationMs: 0 },
    ]);
  });

  test("probe-list array ({name, ok, detail}) maps ok to status and detail to message", () => {
    const checks = normalizeHealthChecks([
      { name: "database", ok: true },
      { name: "memory", ok: false, detail: "rss high" },
    ]);
    expect(checks).toEqual([
      { name: "database", status: "healthy", durationMs: 0 },
      { name: "memory", status: "unhealthy", message: "rss high", durationMs: 0 },
    ]);
  });

  test("rich registry array passes through status, message and durationMs", () => {
    const rich = [{ name: "db", status: "degraded", message: "slow", durationMs: 42 }];
    expect(normalizeHealthChecks(rich)).toEqual([
      { name: "db", status: "degraded", message: "slow", durationMs: 42 },
    ]);
  });

  test("array entries without a name get a positional fallback name", () => {
    const checks = normalizeHealthChecks([{ ok: true }]);
    expect(checks[0]?.name).toBe("check_0");
  });

  test("non-object inputs produce an empty list, never a crash", () => {
    expect(normalizeHealthChecks(null)).toEqual([]);
    expect(normalizeHealthChecks("healthy")).toEqual([]);
    expect(normalizeHealthChecks(42)).toEqual([]);
  });
});

describe("normalizeHealthChecks hardening (review follow-up)", () => {
  test("an unknown status string falls back to the ok-derived status", () => {
    expect(normalizeHealthChecks({ db: { status: "weird", ok: false } })).toEqual([
      { name: "db", status: "unhealthy", durationMs: 0 },
    ]);
  });

  test("a primitive entry value yields a healthy default check", () => {
    expect(normalizeHealthChecks({ process: true })).toEqual([
      { name: "process", status: "healthy", durationMs: 0 },
    ]);
  });
});
