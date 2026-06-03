/**
 * Tests for the `ErrorBoundary` recovery logic.
 *
 * The existing test setup is logic-only (no happy-dom / jsdom), so the full
 * render lifecycle (child throws → fallback mounts → Retry resets) cannot be
 * exercised here. Instead we cover the load-bearing pure piece: the static
 * `getDerivedStateFromError` mapping that React calls to switch the boundary
 * into its error state. The `render()` branch selection (function fallback vs
 * static node vs default) is trivial enough to be obviously correct given this
 * state shape.
 */

import { describe, expect, test } from "bun:test";
import { ErrorBoundary } from "../src/components/error-boundary";

describe("ErrorBoundary.getDerivedStateFromError", () => {
  test("captures the thrown error into boundary state", () => {
    const error = new Error("boom");
    const next = ErrorBoundary.getDerivedStateFromError(error);
    expect(next).toEqual({ error });
    expect(next.error?.message).toBe("boom");
  });

  test("preserves error identity (so the fallback can read message/stack)", () => {
    const error = new Error("render failed");
    const next = ErrorBoundary.getDerivedStateFromError(error);
    expect(next.error).toBe(error);
  });

  test("normalizes non-Error thrown values into Error objects", () => {
    const next = ErrorBoundary.getDerivedStateFromError("string error");
    expect(next.error).toBeInstanceOf(Error);
    expect(next.error?.message).toBe("string error");
  });
});
