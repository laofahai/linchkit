/**
 * Unit tests for `linch events` subcommands.
 *
 * Tests cover the pure handler functions (runList / runInspect / runReplay /
 * runReplayBatch) with an in-memory EventReplayService stub. The citty
 * wrappers are exercised indirectly: their argument parsing is trivial, and
 * spawning a subprocess for every case would require a live PostgreSQL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventHandlerDefinition } from "@linchkit/core";
import type {
  BatchReplayResult,
  EventDetail,
  EventHandlerRegistry as EventHandlerRegistryType,
  EventListOptions,
  EventReplayService,
  EventSummary,
  ReplayOptions,
  ReplayResult,
} from "@linchkit/core/server";
import { runInspect, runList, runReplay, runReplayBatch, setServiceFactory } from "../events";

// Minimal stub registry that supports getByEvent() — the only method
// runReplay uses for dry-run handler resolution.
function makeRegistryStub(handlers: EventHandlerDefinition[]): EventHandlerRegistryType {
  return {
    getByEvent(eventType: string) {
      return handlers.filter((h) => {
        const listen = Array.isArray(h.listen) ? h.listen : [h.listen];
        return listen.includes(eventType);
      });
    },
  } as unknown as EventHandlerRegistryType;
}

// ── Test doubles ────────────────────────────────────────────

interface ServiceStub extends EventReplayService {
  calls: {
    list: EventListOptions[];
    get: string[];
    replay: Array<{ id: string; opts: ReplayOptions | undefined }>;
    replayBatch: Array<{ ids: string[]; opts: ReplayOptions | undefined }>;
  };
}

function makeService(overrides?: Partial<EventReplayService>): ServiceStub {
  const calls: ServiceStub["calls"] = {
    list: [],
    get: [],
    replay: [],
    replayBatch: [],
  };
  const stub: ServiceStub = {
    calls,
    async list(opts?: EventListOptions) {
      calls.list.push(opts ?? {});
      return overrides?.list ? overrides.list(opts) : { items: [], total: 0 };
    },
    async get(id: string) {
      calls.get.push(id);
      return overrides?.get ? overrides.get(id) : null;
    },
    async replay(id: string, opts?: ReplayOptions) {
      calls.replay.push({ id, opts });
      return overrides?.replay ? overrides.replay(id, opts) : { delivered: 0, errors: [] };
    },
    async replayBatch(ids: string[], opts?: ReplayOptions) {
      calls.replayBatch.push({ ids, opts });
      return overrides?.replayBatch
        ? overrides.replayBatch(ids, opts)
        : { results: [], totalDelivered: 0, totalErrors: 0 };
    },
    async handlerHistory() {
      return [];
    },
  };
  return stub;
}

function summary(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    tenantId: overrides.tenantId,
    eventType: overrides.eventType ?? "record.created",
    status: overrides.status ?? "completed",
    sourceAction: overrides.sourceAction ?? "create_purchase",
    sourceExecutionId: overrides.sourceExecutionId ?? "exec-1",
    retryCount: overrides.retryCount ?? 0,
    errorMessage: overrides.errorMessage,
    createdAt: overrides.createdAt ?? new Date("2026-05-01T10:00:00Z"),
    processedAt: overrides.processedAt,
    recordId: overrides.recordId,
  };
}

function detail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    ...summary(overrides),
    payload: overrides.payload ?? { recordId: "rec-1" },
    meta: overrides.meta ?? null,
    history: overrides.history ?? [
      {
        eventId: overrides.id ?? "11111111-1111-1111-1111-111111111111",
        handler: "*",
        status: "completed",
        retryCount: 0,
        attemptedAt: new Date("2026-05-01T10:00:01Z"),
        completedAt: new Date("2026-05-01T10:00:02Z"),
      },
    ],
  };
}

// ── stdout/stderr capture ──────────────────────────────────

let stdoutBuf: string[] = [];
let stderrBuf: string[] = [];
const origLog = console.log;
const origError = console.error;

beforeEach(() => {
  stdoutBuf = [];
  stderrBuf = [];
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => {
    stdoutBuf.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderrBuf.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  setServiceFactory(null);
  process.exitCode = undefined;
});

const stdout = () => stdoutBuf.join("\n");
const stderr = () => stderrBuf.join("\n");

// ── runList ────────────────────────────────────────────────

describe("runList", () => {
  test("renders table with truncated id columns by default", async () => {
    const svc = makeService({
      async list() {
        return {
          items: [
            summary({
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              sourceAction: "create_order",
              recordId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            }),
          ],
          total: 1,
        };
      },
    });
    await runList(svc, {});
    const out = stdout();
    expect(out).toContain("Timestamp");
    expect(out).toContain("Entity");
    expect(out).toContain("RecordId");
    expect(out).toContain("EventType");
    expect(out).toContain("Id");
    expect(out).toContain("create_order");
    // Truncated to first 8 chars + ellipsis; full UUID must NOT appear.
    expect(out).toContain("aaaaaaaa…");
    expect(out).toContain("bbbbbbbb…");
    expect(out).not.toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(out).toContain("Showing 1 of 1 event(s).");
  });

  test("--full renders ids without truncation", async () => {
    const svc = makeService({
      async list() {
        return {
          items: [
            summary({
              id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              recordId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            }),
          ],
          total: 1,
        };
      },
    });
    await runList(svc, { full: true });
    const out = stdout();
    expect(out).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(out).toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(out).not.toContain("aaaaaaaa…");
  });

  test("emits JSON when --json is set", async () => {
    const svc = makeService({
      async list() {
        return { items: [summary()], total: 1 };
      },
    });
    await runList(svc, { json: true });
    const parsed = JSON.parse(stdout());
    expect(parsed.total).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });

  test("forwards --entity/--record/--since/--until/--limit/--offset to service", async () => {
    const svc = makeService();
    await runList(svc, {
      entity: "create_order",
      record: "rec-123",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-02T00:00:00Z",
      limit: 25,
      offset: 5,
    });
    expect(svc.calls.list).toHaveLength(1);
    const opts = svc.calls.list[0] ?? {};
    expect(opts.entity).toBe("create_order");
    expect(opts.recordId).toBe("rec-123");
    expect(opts.since?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(opts.until?.toISOString()).toBe("2026-05-02T00:00:00.000Z");
    expect(opts.limit).toBe(25);
    expect(opts.offset).toBe(5);
  });

  test("--record is passed straight through (no client-side filter, no svc.get calls)", async () => {
    const svc = makeService({
      async list() {
        return {
          items: [summary({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", recordId: "rec-9" })],
          total: 1,
        };
      },
    });
    await runList(svc, { record: "rec-9" });
    expect(svc.calls.list).toHaveLength(1);
    expect(svc.calls.list[0]?.recordId).toBe("rec-9");
    // The old implementation called svc.get() once per row; verify that's gone.
    expect(svc.calls.get).toHaveLength(0);
    expect(stdout()).toContain("Showing 1 of 1 event(s).");
  });

  test("prints friendly message when no events", async () => {
    const svc = makeService();
    await runList(svc, {});
    expect(stdout()).toContain("No events found.");
  });

  test("rejects invalid --since date", async () => {
    const svc = makeService();
    await expect(runList(svc, { since: "not-a-date" })).rejects.toThrow(/Invalid ISO date/);
  });
});

// ── runInspect ─────────────────────────────────────────────

describe("runInspect", () => {
  test("prints event header + payload + handler history", async () => {
    const svc = makeService({
      async get() {
        return detail({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
      },
    });
    await runInspect(svc, { eventId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    const out = stdout();
    expect(out).toContain("Event bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(out).toContain("Type:");
    expect(out).toContain("record.created");
    expect(out).toContain("Payload:");
    expect(out).toContain("Handler History:");
    expect(out).toContain('"recordId": "rec-1"');
  });

  test("emits JSON when --json is set", async () => {
    const svc = makeService({
      async get() {
        return detail();
      },
    });
    await runInspect(svc, { eventId: "11111111-1111-1111-1111-111111111111", json: true });
    const parsed = JSON.parse(stdout());
    expect(parsed.eventType).toBe("record.created");
  });

  test("reports missing event with exitCode=1", async () => {
    const svc = makeService();
    await runInspect(svc, { eventId: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Event not found");
  });
});

// ── runReplay ──────────────────────────────────────────────

describe("runReplay", () => {
  test("dry-run does not invoke replay()", async () => {
    const svc = makeService({
      async get() {
        return detail();
      },
    });
    await runReplay(svc, {
      eventId: "11111111-1111-1111-1111-111111111111",
      dryRun: true,
      json: true,
    });
    expect(svc.calls.replay).toHaveLength(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.eventId).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("dry-run reports missing event with exitCode=1", async () => {
    const svc = makeService();
    await runReplay(svc, {
      eventId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      dryRun: true,
    });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Event not found");
  });

  test("live replay reports missing event with exitCode=1", async () => {
    const svc = makeService(); // default get() returns null
    await runReplay(svc, {
      eventId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      yes: true,
    });
    expect(svc.calls.replay).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Event not found");
  });

  test("--yes skips confirmation and invokes replay()", async () => {
    const result: ReplayResult = { delivered: 2, errors: [] };
    const svc = makeService({
      async get() {
        return detail();
      },
      async replay() {
        return result;
      },
    });
    await runReplay(svc, {
      eventId: "11111111-1111-1111-1111-111111111111",
      yes: true,
      json: true,
    });
    expect(svc.calls.replay).toHaveLength(1);
    const parsed = JSON.parse(stdout());
    expect(parsed.delivered).toBe(2);
  });

  test("--handlers list dispatches once per handler with onlyHandler set", async () => {
    const svc = makeService({
      async get() {
        return detail();
      },
      async replay(_id, opts) {
        return { delivered: opts?.onlyHandler ? 1 : 0, errors: [] };
      },
    });
    await runReplay(svc, {
      eventId: "11111111-1111-1111-1111-111111111111",
      handlers: "h1,h2",
      yes: true,
      json: true,
    });
    expect(svc.calls.replay.map((c) => c.opts?.onlyHandler)).toEqual(["h1", "h2"]);
    const parsed = JSON.parse(stdout());
    expect(parsed.delivered).toBe(2);
  });

  test("sets exitCode=2 when replay returns errors", async () => {
    const svc = makeService({
      async get() {
        return detail();
      },
      async replay() {
        return { delivered: 0, errors: [{ handler: "h1", message: "boom" }] };
      },
    });
    await runReplay(svc, {
      eventId: "11111111-1111-1111-1111-111111111111",
      yes: true,
    });
    expect(process.exitCode).toBe(2);
    expect(stdout()).toContain("boom");
  });

  test("dry-run with registry reports actual handlers for the event type", async () => {
    const svc = makeService({
      async get() {
        return detail({ eventType: "purchase_request.created" });
      },
    });
    const registry = makeRegistryStub([
      {
        name: "send-notification",
        listen: "purchase_request.created",
        handler: async () => {},
      } as EventHandlerDefinition,
      {
        name: "audit-trail",
        listen: ["purchase_request.created", "purchase_request.updated"],
        handler: async () => {},
      } as EventHandlerDefinition,
      {
        name: "unrelated",
        listen: "purchase_request.deleted",
        handler: async () => {},
      } as EventHandlerDefinition,
    ]);
    await runReplay(
      svc,
      {
        eventId: "11111111-1111-1111-1111-111111111111",
        dryRun: true,
        json: true,
      },
      registry,
    );
    const parsed = JSON.parse(stdout());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.handlers).toEqual(["send-notification", "audit-trail"]);
  });
});

// ── runReplayBatch ─────────────────────────────────────────

describe("runReplayBatch", () => {
  test("dry-run lists planned ids without invoking replayBatch()", async () => {
    const svc = makeService({
      async list() {
        return {
          items: [
            summary({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
            summary({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
          ],
          total: 2,
        };
      },
    });
    await runReplayBatch(svc, { dryRun: true, json: true });
    expect(svc.calls.replayBatch).toHaveLength(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.planned).toBe(2);
    expect(parsed.ids).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
  });

  test("--yes invokes replayBatch with matched ids", async () => {
    const batchResult: BatchReplayResult = {
      results: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", replayed: true, delivered: 1, errors: [] },
      ],
      totalDelivered: 1,
      totalErrors: 0,
    };
    const svc = makeService({
      async list() {
        return { items: [summary({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })], total: 1 };
      },
      async replayBatch() {
        return batchResult;
      },
    });
    await runReplayBatch(svc, { yes: true, json: true });
    expect(svc.calls.replayBatch).toHaveLength(1);
    expect(svc.calls.replayBatch[0]?.ids).toEqual(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
    const parsed = JSON.parse(stdout());
    expect(parsed.totalDelivered).toBe(1);
  });

  test("forwards --entity/--since/--until/--limit to list()", async () => {
    const svc = makeService();
    await runReplayBatch(svc, {
      entity: "create_order",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-02T00:00:00Z",
      limit: 10,
      dryRun: true,
    });
    expect(svc.calls.list).toHaveLength(1);
    const opts = svc.calls.list[0] ?? {};
    expect(opts.entity).toBe("create_order");
    expect(opts.limit).toBe(10);
  });

  test("sets exitCode=2 when batch returns errors", async () => {
    const svc = makeService({
      async list() {
        return { items: [summary()], total: 1 };
      },
      async replayBatch() {
        return {
          results: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              replayed: true,
              delivered: 0,
              errors: [{ handler: "h", message: "fail" }],
            },
          ],
          totalDelivered: 0,
          totalErrors: 1,
        };
      },
    });
    await runReplayBatch(svc, { yes: true });
    expect(process.exitCode).toBe(2);
  });

  test("emits empty JSON when no events match", async () => {
    const svc = makeService();
    await runReplayBatch(svc, { json: true });
    const parsed = JSON.parse(stdout());
    expect(parsed.results).toEqual([]);
    expect(parsed.totalDelivered).toBe(0);
  });
});

// ── setServiceFactory ──────────────────────────────────────

describe("setServiceFactory", () => {
  test("setServiceFactory(null) restores the default factory without throwing", () => {
    setServiceFactory(async () => {
      throw new Error("should not be called");
    });
    expect(() => setServiceFactory(null)).not.toThrow();
  });
});
