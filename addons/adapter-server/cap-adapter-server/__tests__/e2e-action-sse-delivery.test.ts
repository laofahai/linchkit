/**
 * Action-driven SSE delivery e2e (in-process, DB-free, port-free).
 *
 * Regression guard for issue #482: action-driven SSE delivery was broken for
 * CRUD writes. The chain that failed:
 *   1. `build-crud-actions.ts` emitted `record.created` with a `schema` field
 *      but NO `entity` field.
 *   2. `action-engine.ts` flushed pending events to the bus reading
 *      `pe.payload.entity` — which was `undefined` for CRUD emits.
 *   3. `subscription-manager.ts` `dispatchEvent` early-returns when
 *      `event.entity` is missing → SSE subscribers NEVER received
 *      action-driven create/update/delete events.
 *
 * Unlike `e2e-sse-subscribe.test.ts` (which works around the bug by emitting a
 * hand-shaped `EventRecord` with `entity` already set directly on the bus), this
 * test drives the REAL path: it opens an SSE subscription and then creates a
 * record THROUGH A CRUD ACTION (GraphQL `create_<entity>` mutation). That
 * exercises build-crud-actions → action-engine event flush → SubscriptionManager,
 * proving the whole chain delivers the event to the open SSE stream.
 *
 * Dispatch is in-process via `app.handle(new Request(...))` ONLY — never
 * `app.listen(PORT)` (a bound socket passes in isolation but SEGFAULTS the
 * batched runner). The streaming read uses a hard timeout so the test can never
 * hang, and cleanup cancels the reader (never `app.stop()`).
 */

import { describe, expect, it } from "bun:test";
import type { CapabilityDefinition, EntityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { capAdapterServer } from "../src/capability";
import { createDevApp } from "../src/dev-app";

// ── Synthetic business capability (inline) ───────────────────────────────────
//
// One entity with its auto-generated CRUD — enough to mount the entity into the
// registry so the SSE permission checker recognizes it as a readable schema and
// so `create_sse_task` exists as a GraphQL mutation.

const taskEntity: EntityDefinition = {
  name: "sse_task",
  label: "SSE Task",
  description: "Synthetic entity for the action-driven SSE delivery e2e",
  fields: {
    title: { type: "string", required: true, label: "Title", ui: { importance: "primary" } },
  },
};

const capSseBusiness: CapabilityDefinition = defineCapability({
  name: "cap-sse-action-business",
  label: "SSE Action Business",
  description:
    "Synthetic business capability (inline) — one entity for action-driven SSE delivery tests",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [taskEntity],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read one SSE frame (text up to the `\n\n` terminator) from a stream reader,
 * bounded by a hard timeout so the test can never hang. Resolves to the
 * accumulated text on the first chunk (or "" if the timeout fires first).
 *
 * Mirrors the helper in `e2e-sse-subscribe.test.ts`, including clearing the
 * timer in `finally` so it does not linger as a background timer.
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
    if (timer) clearTimeout(timer);
  }
}

/** POST a GraphQL operation through `app.handle` (no port, no network). */
async function postGraphQL(
  app: ReturnType<typeof createDevApp>["app"],
  query: string,
  variables?: Record<string, unknown>,
): Promise<Response> {
  return app.handle(
    new Request("http://local.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
  );
}

// ── Type helpers (no `any`) ──────────────────────────────────────────────────

interface CreatedTask {
  id: string;
  title: string;
}

interface CreateTaskResponse {
  data: { createSseTask: CreatedTask } | null;
  errors?: Array<{ message: string }>;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("action-driven SSE delivery e2e (in-process, DB-free, port-free)", () => {
  it("delivers record.created over SSE when a record is created THROUGH a CRUD action", async () => {
    const { app } = createDevApp([capAdapterServer, capSseBusiness], { cors: false });

    // Open the SSE subscription FIRST so the connection is registered before the
    // action fires. In-memory delivery is synchronous, so once the create action
    // resolves the event has already been pushed into this stream's buffer.
    const subRes = await app.handle(
      new Request("http://local.test/api/subscribe?entities=sse_task", { method: "GET" }),
    );
    expect(subRes.status).toBe(200);
    expect(subRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = (subRes.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // Drain the initial `connected` frame so the next read targets our event.
    const connected = await readChunkWithTimeout(reader, decoder, 2000);
    expect(connected).toContain("event: connected");

    // Create a record THROUGH THE CRUD ACTION (GraphQL create mutation). This is
    // the REAL path under test: build-crud-actions emits `record.created`, the
    // action engine flushes it to the bus, and the SubscriptionManager dispatches
    // it to this open subscription. Before the #482 fix the CRUD emit carried
    // only `schema` (no `entity`), so the bus EventRecord had `entity:
    // undefined` and `dispatchEvent` early-returned — the read below would then
    // time out to "".
    const createRes = await postGraphQL(
      app,
      `mutation CreateTask($input: SseTaskInput!) {
        createSseTask(input: $input) {
          id
          title
        }
      }`,
      { input: { title: "ship it" } },
    );
    expect(createRes.status).toBe(200);

    const createBody = (await createRes.json()) as CreateTaskResponse;
    expect(createBody.errors).toBeUndefined();
    const created = createBody.data?.createSseTask;
    expect(created).toBeDefined();
    expect(typeof created?.id).toBe("string");
    expect(created?.id).toBeTruthy();
    expect(created?.title).toBe("ship it");

    const createdId = created?.id as string;

    // The action-driven event must arrive on the open SSE stream as a
    // `record.created` frame carrying the canonical `entity` name and the right
    // recordId. A bounded read keeps the test from hanging if the chain is broken.
    const eventFrame = await readChunkWithTimeout(reader, decoder, 2000);
    expect(eventFrame).toContain("event: record.created");
    expect(eventFrame).toContain('"entity":"sse_task"');
    expect(eventFrame).toContain(`"recordId":"${createdId}"`);

    // Cancelling the reader closes the SSE stream, removing the subscription and
    // clearing its per-connection heartbeat/idle timers. Never call app.stop().
    await reader.cancel();
  });
});
