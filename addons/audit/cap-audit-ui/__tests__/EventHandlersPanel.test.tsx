/**
 * EventHandlersPanel tests.
 *
 * Same DOM-less constraint as EventTimeline.test.tsx — we assert:
 *   - the component + truncate helper are exported
 *   - `truncateError` clamps long messages and adds an ellipsis (the
 *     panel only renders the truncated preview, so this is the unit of
 *     observable behaviour)
 *   - the mocked `graphql()` returns rows the panel can render directly,
 *     including a success row and an error row (status icon selection
 *     in the panel is purely a function of `row.status`).
 *
 * Mirrors the existing audit-ui mock pattern (spread + override) from
 * PR#310 so other test files keep working.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const graphqlMock = mock(async (_query: string, _vars?: Record<string, unknown>) => ({ data: {} }));

const apiActual = await import("@linchkit/cap-adapter-ui/lib/api");
mock.module("@linchkit/cap-adapter-ui/lib/api", () => ({
  ...apiActual,
  graphql: graphqlMock,
}));

const { getHandlerHistory } = await import("../src/lib/eventsClient");
const { default: EventHandlersPanel, truncateError } = await import(
  "../src/views/EventHandlersPanel"
);

beforeEach(() => {
  graphqlMock.mockClear();
});

afterEach(() => {
  graphqlMock.mockReset();
});

// ── Export shape ────────────────────────────────────────

describe("EventHandlersPanel exports", () => {
  it("exposes the component and the truncate helper", () => {
    expect(typeof EventHandlersPanel).toBe("function");
    expect(typeof truncateError).toBe("function");
  });
});

// ── Error truncation ────────────────────────────────────

describe("truncateError", () => {
  it("leaves short strings untouched", () => {
    expect(truncateError("nope", 10)).toBe("nope");
  });

  it("clamps long strings and appends an ellipsis", () => {
    const long = "x".repeat(200);
    const out = truncateError(long, 50);
    expect(out).toHaveLength(51); // 50 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 50)).toBe("x".repeat(50));
  });

  it("uses a sensible default limit so the call site can omit it", () => {
    const long = "y".repeat(300);
    const out = truncateError(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });
});

// ── Handler history wiring ──────────────────────────────

describe("EventHandlersPanel + getHandlerHistory", () => {
  it("returns success / error / pending rows so status icons render", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventHandlerHistory: [
          {
            handler: "cap-cache:invalidate",
            status: "completed",
            durationMs: 4,
            error: null,
          },
          {
            handler: "cap-notify:send",
            status: "failed",
            durationMs: 12,
            error: "smtp unreachable",
          },
          {
            handler: "*",
            status: "pending",
            durationMs: null,
            error: null,
          },
        ],
      },
    }));

    const rows = await getHandlerHistory("11111111-1111-1111-1111-111111111111");
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);

    // The panel picks a status icon by row.status — verify each status
    // arrives intact so the success / error / pending branches all
    // exercise the correct icon.
    expect(rows[0]).toMatchObject({ handler: "cap-cache:invalidate", status: "completed" });
    expect(rows[1]).toMatchObject({ handler: "cap-notify:send", status: "failed" });
    expect(rows[2]?.handler).toBe("*");
  });

  it("returns the truncated preview the panel renders inline", async () => {
    const longError = "a".repeat(500);
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventHandlerHistory: [
          {
            handler: "cap-notify:send",
            status: "failed",
            durationMs: 7,
            error: longError,
          },
        ],
      },
    }));

    const rows = await getHandlerHistory("22222222-2222-2222-2222-222222222222");
    const fullError = rows[0]?.error ?? "";
    expect(fullError.length).toBe(500);
    // The panel always renders `truncateError(fullError)` — assert that
    // the rendered preview is bounded.
    const preview = truncateError(fullError);
    expect(preview.length).toBeLessThanOrEqual(121);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("surfaces GraphQL errors so the panel can show its error banner", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      errors: [{ message: "eventHandlerHistory missing" }],
    }));

    await expect(getHandlerHistory("33333333-3333-3333-3333-333333333333")).rejects.toThrow(
      "eventHandlerHistory missing",
    );
  });
});
