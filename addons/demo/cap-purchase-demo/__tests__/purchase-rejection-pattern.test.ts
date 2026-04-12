/**
 * Tests for purchase_rejection_pattern Sensor.
 *
 * The sensor counts succeeded `reject_purchase_request` execution_log records
 * within a 30-day window and emits a SensorSignal. It returns null when no
 * query helper is provided.
 */

import { describe, expect, test } from "bun:test";
import type { SensorContext } from "@linchkit/core";
import { purchaseRejectionPattern } from "../src/sensors/purchase-rejection-pattern";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface QueryCall {
  schema: string;
  filter?: Record<string, unknown>;
}

function makeContext(opts: {
  rows?: Array<Record<string, unknown>>;
  timestamp?: Date;
  tenantId?: string;
  withQuery?: boolean;
}): { ctx: SensorContext; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const ctx: SensorContext = {
    timestamp: opts.timestamp ?? new Date("2026-04-11T00:00:00.000Z"),
    tenantId: opts.tenantId,
    query:
      opts.withQuery === false
        ? undefined
        : async <T>(schema: string, filter?: Record<string, unknown>) => {
            calls.push({ schema, filter });
            return (opts.rows ?? []) as T[];
          },
  };
  return { ctx, calls };
}

describe("purchaseRejectionPattern sensor", () => {
  test("has expected metadata", () => {
    expect(purchaseRejectionPattern.name).toBe("purchase_rejection_pattern");
    expect(purchaseRejectionPattern.source).toBe("event_bus");
    expect(purchaseRejectionPattern.entity).toBe("purchase_request");
  });

  test("returns null when ctx.query is undefined", async () => {
    const { ctx } = makeContext({ withQuery: false });
    const signal = await purchaseRejectionPattern.detect(ctx);
    expect(signal).toBeNull();
  });

  test("queries execution_log with action_name + status filter", async () => {
    const { ctx, calls } = makeContext({ rows: [] });
    const signal = await purchaseRejectionPattern.detect(ctx);

    expect(signal).not.toBeNull();
    expect(signal?.value).toBe(0);
    expect(signal?.confidence).toBeCloseTo(0.5);
    expect(signal?.sensor).toBe("purchase_rejection_pattern");
    expect(signal?.source).toBe("event_bus");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.schema).toBe("execution_log");
    expect(calls[0]?.filter).toEqual({
      action_name: "reject_purchase_request",
      status: "succeeded",
    });
  });

  test("counts rejection events within the 30-day window", async () => {
    const now = new Date("2026-04-11T00:00:00.000Z");
    const inWindow = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5d ago
    const outOfWindow = new Date(now.getTime() - (WINDOW_MS + 60_000)); // > window

    const { ctx } = makeContext({
      timestamp: now,
      rows: [
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inWindow },
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inWindow },
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inWindow },
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inWindow },
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: outOfWindow }, // excluded
      ],
    });

    const signal = await purchaseRejectionPattern.detect(ctx);
    expect(signal).not.toBeNull();
    expect(signal?.value).toBe(4);
    // value >= 3 → high confidence
    expect(signal?.confidence).toBeCloseTo(0.8);
  });

  test("accepts ISO-string timestamps and EXCLUDES records with missing/invalid timestamps", async () => {
    // A successful execution must have a completed_at. Missing/invalid is
    // treated as data corruption — under-count rather than over-count.
    const now = new Date("2026-04-11T00:00:00.000Z");
    const inWindowIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const { ctx } = makeContext({
      timestamp: now,
      rows: [
        // ISO string within window — counted
        {
          action_name: "reject_purchase_request",
          status: "succeeded",
          completed_at: inWindowIso,
        },
        // null timestamp — excluded
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: null },
        // missing field — excluded
        { action_name: "reject_purchase_request", status: "succeeded" },
        // invalid date string — excluded
        {
          action_name: "reject_purchase_request",
          status: "succeeded",
          completed_at: "not-a-date",
        },
      ],
    });

    const signal = await purchaseRejectionPattern.detect(ctx);
    expect(signal?.value).toBe(1);
  });

  test("EXCLUDES records with future timestamps (clock skew / corruption guard)", async () => {
    // completed_at after ctx.timestamp indicates data corruption or clock skew.
    // Those records should not count toward the window.
    const now = new Date("2026-04-11T00:00:00.000Z");
    const inWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1d ago
    const inFuture = new Date(now.getTime() + 60_000); // 1min in the future

    const { ctx } = makeContext({
      timestamp: now,
      rows: [
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inWindow },
        { action_name: "reject_purchase_request", status: "succeeded", completed_at: inFuture },
      ],
    });

    const signal = await purchaseRejectionPattern.detect(ctx);
    expect(signal?.value).toBe(1);
  });

  test("produces a fully-populated SensorSignal", async () => {
    const now = new Date("2026-04-11T00:00:00.000Z");
    const { ctx } = makeContext({
      timestamp: now,
      tenantId: "tenant-1",
      rows: [{ action_name: "reject_purchase_request", status: "succeeded", completed_at: now }],
    });

    const signal = await purchaseRejectionPattern.detect(ctx);
    expect(signal).not.toBeNull();
    if (!signal) return;

    expect(signal.sensor).toBe("purchase_rejection_pattern");
    expect(signal.source).toBe("event_bus");
    expect(signal.timestamp).toBe(now);
    expect(signal.value).toBe(1);
    expect(signal.baseline).toBe(0);
    expect(signal.deviation).toBe(0);
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.context).toMatchObject({
      entity: "purchase_request",
      metric: "rejection_count",
      windowMs: WINDOW_MS,
      tenantId: "tenant-1",
    });
    expect(typeof signal.context.windowStart).toBe("string");
  });
});
