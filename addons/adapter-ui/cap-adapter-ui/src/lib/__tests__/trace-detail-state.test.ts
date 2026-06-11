/**
 * resolveStoredResult tests — the trace-detail panel's "result belongs to the
 * selected trace" guard (pure logic, no jsdom).
 *
 * These cover the two review findings fixed at this seam:
 * - close (traceId undefined) must never surface a previous trace's result;
 * - switching trace A → B must hide A's result (skeleton) until B's arrives,
 *   even though A's result is still the stored state at that point.
 *
 * The render wiring itself (Sheet/skeleton JSX) has no jsdom harness in this
 * package and is intentionally not rendered here.
 */

import { describe, expect, test } from "bun:test";
import type { AITraceGenerationsResult } from "../ai-traces-client";
import { resolveStoredResult, type StoredGenerationsResult } from "../trace-detail-state";

const OK_RESULT: AITraceGenerationsResult = { kind: "ok", generations: [], count: 0 };

const STORED_A: StoredGenerationsResult = { traceId: "trace-a", result: OK_RESULT };

describe("resolveStoredResult", () => {
  test("returns the stored result when it belongs to the selected trace", () => {
    expect(resolveStoredResult(STORED_A, "trace-a")).toBe(OK_RESULT);
  });

  test("returns null when nothing has been stored yet (initial open)", () => {
    expect(resolveStoredResult(null, "trace-a")).toBeNull();
  });

  test("returns null when the panel is closed (undefined traceId)", () => {
    // Close while A's result is still stored — must not surface it.
    expect(resolveStoredResult(STORED_A, undefined)).toBeNull();
  });

  test("returns null when the stored result belongs to a previous trace (A → B switch)", () => {
    // The pre-effect frame after selecting B: stored is still A's result.
    expect(resolveStoredResult(STORED_A, "trace-b")).toBeNull();
  });

  test("non-ok results are also keyed to their trace", () => {
    const denied: AITraceGenerationsResult = { kind: "denied", message: "Access denied" };
    const stored: StoredGenerationsResult = { traceId: "trace-a", result: denied };
    expect(resolveStoredResult(stored, "trace-a")).toBe(denied);
    expect(resolveStoredResult(stored, "trace-b")).toBeNull();
  });
});
