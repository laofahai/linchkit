/**
 * SSE subscription e2e (in-process, DB-free, port-free).
 *
 * Regression guard for the dormant-eventBus wiring fix. The in-process boot
 * path (`createDevApp` → `assembleDevSchema` → `createRuntimeContext`) never
 * wired an event bus, so:
 *   - `mountSubscriptionRoutes` early-returned (`subscription-api.ts`:
 *     `if (!eventBus) return;`) → `GET /api/subscribe` was a dead route, and
 *   - actions emitted domain events into a void (no bus → no subscribers).
 *
 * The fix assembles an in-memory bus in `assembleDevSchema`, threads it into
 * `createActionExecutor` (via `createRuntimeContext`), and forwards it to
 * `createServer` (via `createDevApp`). This test proves that wiring is LIVE:
 *
 *   1. `GET /api/subscribe` returns HTTP 200 with `content-type:
 *      text/event-stream` and streams the initial `connected` SSE frame —
 *      impossible when the route early-returns on a missing bus.
 *   2. A domain event emitted on the wired bus (`assembled.runtime.eventBus`)
 *      flows through the SubscriptionManager and arrives on the open SSE stream
 *      as a `record.created` frame — proving the bus the server mounts and the
 *      bus actions emit on are the same, end to end.
 *
 * Dispatch is in-process via `app.handle(new Request(...))` ONLY — never
 * `app.listen(PORT)`. A bound socket passes in isolation but SEGFAULTS the
 * batched runner; the streaming read uses a hard timeout so the test can never
 * hang. Mirrors the bootstrap in `smoke-action-roundtrip.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { CapabilityDefinition, EntityDefinition, EventRecord } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { capAdapterServer } from "../src/capability";
import { createDevApp } from "../src/dev-app";

// ── Synthetic business capability (inline) ───────────────────────────────────
//
// One entity with its auto-generated CRUD — enough to mount the entity into the
// registry so the SSE permission checker recognizes it as a readable schema.

const noteEntity: EntityDefinition = {
  name: "sse_note",
  label: "SSE Note",
  description: "Synthetic entity for the SSE subscription e2e",
  fields: {
    title: { type: "string", required: true, label: "Title", ui: { importance: "primary" } },
  },
};

const capSseBusiness: CapabilityDefinition = defineCapability({
  name: "cap-sse-business",
  label: "SSE Business",
  description: "Synthetic business capability (inline) — one entity for SSE subscription tests",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [noteEntity],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read one SSE frame (text up to the `\n\n` terminator) from a stream reader,
 * bounded by a hard timeout so the test can never hang. Resolves to the
 * accumulated text on the first chunk (or whatever has arrived by the timeout).
 */
async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: undefined; done: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: undefined, done: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([reader.read(), timeout]);
    return result.value ? decoder.decode(result.value) : "";
  } finally {
    // Clear the timer on the happy path so it does not linger as a background
    // timer after the read resolves (avoids batched-runner timer accumulation).
    if (timer) clearTimeout(timer);
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("SSE /api/subscribe e2e (in-process, DB-free, port-free)", () => {
  it("returns 200 + text/event-stream and streams the initial connected frame", async () => {
    const { app } = createDevApp([capAdapterServer, capSseBusiness], { cors: false });

    const res = await app.handle(
      new Request("http://local.test/api/subscribe?entities=sse_note", { method: "GET" }),
    );

    // Core regression guard: before the fix, a missing eventBus made
    // mountSubscriptionRoutes early-return → this route would 404 / not stream.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // The stream must be readable and deliver the initial `connected` frame.
    const body = res.body as ReadableStream<Uint8Array> | null;
    expect(body).not.toBeNull();
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    const firstFrame = await readChunkWithTimeout(reader, decoder, 2000);
    expect(firstFrame).toContain("event: connected");
    expect(firstFrame).toContain("connectionId");

    // Cancelling the reader closes the SSE stream, which removes the
    // subscription and clears its per-connection heartbeat/idle timers.
    await reader.cancel();
  });

  it("delivers a domain event emitted on the wired bus to an open subscription", async () => {
    const { app, assembled } = createDevApp([capAdapterServer, capSseBusiness], { cors: false });

    // The bus must now exist on the runtime (it was undefined before the fix).
    const eventBus = assembled.runtime.eventBus;
    expect(eventBus).toBeDefined();

    const res = await app.handle(
      new Request("http://local.test/api/subscribe?entities=sse_note", { method: "GET" }),
    );
    expect(res.status).toBe(200);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // Drain the initial `connected` frame so the next read targets our event.
    const connected = await readChunkWithTimeout(reader, decoder, 2000);
    expect(connected).toContain("event: connected");

    // Emit a properly-shaped domain event on the SAME bus the server mounts and
    // actions emit on. If the bus were not forwarded to createServer, the
    // SubscriptionManager would not be listening and this frame would never
    // arrive (the read below would time out to "").
    const domainEvent: EventRecord = {
      id: crypto.randomUUID(),
      type: "record.created",
      category: "change",
      timestamp: new Date(),
      actor: { type: "system", id: "sse-test" },
      entity: "sse_note",
      recordId: "note-1",
      executionId: "exec-sse-test",
      payload: { id: "note-1", title: "hello" },
    };
    if (!eventBus) throw new Error("eventBus was not wired by the dev boot path");
    await eventBus.emit(domainEvent);

    // Bounded read — the event is delivered synchronously to in-memory
    // subscribers, so a short timeout is a safety net, not the happy path.
    const eventFrame = await readChunkWithTimeout(reader, decoder, 2000);
    expect(eventFrame).toContain("event: record.created");
    expect(eventFrame).toContain('"entity":"sse_note"');
    expect(eventFrame).toContain('"recordId":"note-1"');

    await reader.cancel();
  });
});
