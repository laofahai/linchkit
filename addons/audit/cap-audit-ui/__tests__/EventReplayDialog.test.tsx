/**
 * EventReplayDialog tests.
 *
 * Without a DOM we can't simulate the checkbox click directly; instead
 * we exercise the underlying `replayEvent` wire contract that the
 * dialog calls when the user toggles `dryRun` + submits:
 *
 *   - `replayEvent(id, { dryRun: true })` sends `dryRun: true` to the
 *     server (the dialog defaults to dry-run; this proves the wire
 *     payload encodes that default correctly).
 *   - `replayEvent(id, { dryRun: false, handlers: "x" })` sends both
 *     flags through verbatim (the dialog passes them straight through).
 *   - A successful response is shaped exactly like the `ReplayReport`
 *     the summary section reads from, so the counts + handler outcomes
 *     round-trip through the dialog without translation.
 *
 * Mirrors the spread-then-override mock pattern used by the existing
 * audit tests so mock.module() doesn't clobber unrelated exports.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const graphqlMock = mock(async (_query: string, _vars?: Record<string, unknown>) => ({ data: {} }));

const apiActual = await import("@linchkit/cap-adapter-ui/lib/api");
mock.module("@linchkit/cap-adapter-ui/lib/api", () => ({
  ...apiActual,
  graphql: graphqlMock,
}));

const { replayEvent } = await import("../src/lib/eventsClient");
const { default: EventReplayDialog } = await import("../src/views/EventReplayDialog");

beforeEach(() => {
  graphqlMock.mockClear();
});

afterEach(() => {
  graphqlMock.mockReset();
});

// ── Export shape ────────────────────────────────────────

describe("EventReplayDialog exports", () => {
  it("exposes a React component", () => {
    expect(typeof EventReplayDialog).toBe("function");
  });
});

// ── dryRun checkbox toggle (proxy: replayEvent wire payload) ────

describe("EventReplayDialog dryRun toggle", () => {
  it("dispatches dryRun: true when the checkbox is on (dialog default)", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventReplay: {
          eventId: "evt-1",
          dryRun: true,
          delivered: 0,
          failed: 0,
          handlers: [],
        },
      },
    }));

    await replayEvent("evt-1", { dryRun: true });
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const [, vars] = graphqlMock.mock.calls[0] ?? [];
    expect(vars).toMatchObject({ eventId: "evt-1", dryRun: true });
  });

  it("dispatches dryRun: false when the user unchecks the box", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventReplay: {
          eventId: "evt-1",
          dryRun: false,
          delivered: 1,
          failed: 0,
          handlers: [{ handler: "cap-cache:invalidate", status: "success" }],
        },
      },
    }));

    await replayEvent("evt-1", { dryRun: false });
    const [, vars] = graphqlMock.mock.calls[0] ?? [];
    expect(vars).toMatchObject({ eventId: "evt-1", dryRun: false });
  });
});

// ── Submit calls replay with correct args ───────────────

describe("EventReplayDialog submit", () => {
  it("forwards the eventId, dryRun flag, and handler filter to the wire", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventReplay: {
          eventId: "evt-9",
          dryRun: false,
          delivered: 2,
          failed: 0,
          handlers: [
            { handler: "cap-cache:invalidate", status: "success" },
            { handler: "cap-search:index", status: "success" },
          ],
        },
      },
    }));

    await replayEvent("evt-9", { dryRun: false, handlers: "cap-cache:invalidate" });
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const [, vars] = graphqlMock.mock.calls[0] ?? [];
    expect(vars).toEqual({
      eventId: "evt-9",
      dryRun: false,
      handlers: "cap-cache:invalidate",
    });
  });
});

// ── Successful replay → summary shape ───────────────────

describe("EventReplayDialog success summary", () => {
  it("returns a ReplayReport the summary section can render verbatim", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      data: {
        eventReplay: {
          eventId: "evt-9",
          dryRun: false,
          delivered: 1,
          failed: 1,
          handlers: [
            { handler: "cap-cache:invalidate", status: "success" },
            { handler: "cap-notify:send", status: "error", error: "smtp unreachable" },
          ],
        },
      },
    }));

    const report = await replayEvent("evt-9", { dryRun: false });
    expect(report).toMatchObject({
      eventId: "evt-9",
      dryRun: false,
      delivered: 1,
      failed: 1,
    });
    expect(report.handlers).toHaveLength(2);
    expect(report.handlers[0]).toMatchObject({
      handler: "cap-cache:invalidate",
      status: "success",
    });
    expect(report.handlers[1]).toMatchObject({
      handler: "cap-notify:send",
      status: "error",
      error: "smtp unreachable",
    });
  });

  it("throws when the GraphQL response carries errors", async () => {
    graphqlMock.mockImplementationOnce(async () => ({
      errors: [{ message: "event not found" }],
    }));

    await expect(replayEvent("evt-missing")).rejects.toThrow("event not found");
  });

  it("throws when the response is empty so the dialog never renders a phantom summary", async () => {
    graphqlMock.mockImplementationOnce(async () => ({ data: {} }));

    await expect(replayEvent("evt-1")).rejects.toThrow("Replay returned no data");
  });
});
