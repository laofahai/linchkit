/**
 * AG-UI HITL propose-half tests (Spec 71 P2a).
 *
 * Covers the PROPOSE half only (no resume/execute — that is P2b):
 *  - the endpoint attaches an `interrupt` outcome to RUN_FINISHED when the
 *    runner returns an `AgUiInterruptDescriptor`, and a plain finish when it
 *    returns void (read-only path unchanged) — driven via `app.handle`
 *    (in-process, port-free; never `app.listen`);
 *  - the runner SUPPRESSES the `proposeMutation` tool-call frames at the source
 *    (§4.5): NO TOOL_CALL_* events for it ever reach `emit`, asserted by
 *    replaying the runner's exact fullStream loop over a fake model that calls
 *    `proposeMutation` (same `MockLanguageModelV3` pattern as agui-api.test.ts);
 *  - the interrupt store has the open entry after a propose run;
 *  - `computeInputDigest` is stable for the same canonical input.
 */

import { describe, expect, test } from "bun:test";
import {
  type AGUIEvent,
  createAgUiApp,
  EventType,
  InMemoryInterruptStore,
} from "@linchkit/cap-adapter-ag-ui";
import type { Actor, AIService } from "@linchkit/core";
import type { TextStreamPart, ToolSet } from "ai";
import { stepCountIs, streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import {
  buildProposeInterrupt,
  canonicalJson,
  computeInputDigest,
  parseProposeMutationInput,
} from "../agui-runner";
import {
  buildProposeMutationTool,
  PROPOSE_MUTATION_TOOL_CALL_ID_PREFIX,
  PROPOSE_MUTATION_TOOL_NAME,
  type ProposeMutationArgs,
} from "../tools";

// Minimal "configured" AIService — the endpoint's 503 gate reads `.configured`;
// with a runner injected, no provider logic runs through this.
const configuredService = { configured: true } as unknown as AIService;

const HUMAN: Actor = { type: "human", id: "user-1", groups: ["admin"] };

async function readSse(res: Response): Promise<Array<{ type: string } & Record<string, unknown>>> {
  return (await res.text())
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as { type: string });
}

function postRun(app: Awaited<ReturnType<typeof createAgUiApp>>, body: unknown) {
  return app.handle(
    new Request("http://local.test/api/agui/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const createInput = {
  threadId: "t1",
  runId: "rA",
  messages: [{ id: "m1", role: "user", content: "create a product named Widget price 9.9" }],
  tools: [],
  context: [],
};

// ── inputDigest stability (Spec 71 §6.2 point 3) ────────────

describe("computeInputDigest", () => {
  test("is stable regardless of object key insertion order", () => {
    const a = computeInputDigest("create_product", { name: "Widget", price: 9.9 });
    const b = computeInputDigest("create_product", { price: 9.9, name: "Widget" });
    expect(a).toBe(b);
  });

  test("differs when the action differs", () => {
    const a = computeInputDigest("create_product", { name: "Widget" });
    const b = computeInputDigest("update_product", { name: "Widget" });
    expect(a).not.toBe(b);
  });

  test("differs when the input value differs", () => {
    const a = computeInputDigest("create_product", { name: "Widget", price: 9.9 });
    const b = computeInputDigest("create_product", { name: "Widget", price: 8.9 });
    expect(a).not.toBe(b);
  });

  test("canonicalJson sorts nested keys and ignores undefined-valued keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
    // undefined-valued key hashes identically to an absent key (JSON omits it).
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    // arrays keep order.
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

// ── parseProposeMutationInput — a malformed call is NOT a proposal ──
// (review #605: a fallback returning { action: "" } would emit an interrupt with
//  an empty action and write a bogus actionSet:[""] store entry.)

describe("parseProposeMutationInput", () => {
  test("decodes a well-formed call", () => {
    expect(
      parseProposeMutationInput({ action: "create_product", input: { name: "Widget" } }),
    ).toEqual({ action: "create_product", input: { name: "Widget" } });
  });

  test("defaults a missing input to {} (action with no arguments)", () => {
    expect(parseProposeMutationInput({ action: "refresh_cache" })).toEqual({
      action: "refresh_cache",
      input: {},
    });
  });

  test("returns undefined when there is no usable action (no empty-action interrupt)", () => {
    expect(parseProposeMutationInput({ input: { name: "Widget" } })).toBeUndefined();
    expect(parseProposeMutationInput({ action: "", input: {} })).toBeUndefined();
    expect(parseProposeMutationInput({ action: "   " })).toBeUndefined();
    expect(parseProposeMutationInput({ action: 42 })).toBeUndefined();
    expect(parseProposeMutationInput(null)).toBeUndefined();
    expect(parseProposeMutationInput("nonsense")).toBeUndefined();
  });

  test("recovers a usable action and drops bad input", () => {
    expect(parseProposeMutationInput({ action: "create_product", input: "bad" })).toEqual({
      action: "create_product",
      input: {},
    });
  });
});

// ── §4.5 source suppression of proposeMutation frames ───────

describe("proposeMutation tool-call suppression (Spec 71 §4.5)", () => {
  test("a proposeMutation tool-call emits NO TOOL_CALL_* events and is captured", async () => {
    // Fake model: text, then calls proposeMutation and stops (un-executed →
    // the run ends, exactly as the real runner relies on).
    type V3StreamPart =
      Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<
        infer PART
      >
        ? PART
        : never;
    const chunks: V3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Sure." },
      { type: "text-end", id: "t1" },
      {
        type: "tool-call",
        toolCallId: "tc-raw",
        toolName: PROPOSE_MUTATION_TOOL_NAME,
        input: JSON.stringify({ action: "create_product", input: { name: "Widget", price: 9.9 } }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: { stream: convertArrayToReadableStream(chunks) },
    });

    const result = streamText({
      model,
      messages: [{ role: "user", content: "create widget" }],
      tools: buildProposeMutationTool(),
      stopWhen: stepCountIs(5),
    });

    // Replay the runner's EXACT fullStream loop (agui-runner.ts): suppress the
    // proposeMutation tool-call at the source, translate everything else.
    const { streamPartToAgUiEvents } = await import("../agui-runner");
    const emitted: AGUIEvent[] = [];
    let proposal: ProposeMutationArgs | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "tool-call" && part.toolName === PROPOSE_MUTATION_TOOL_NAME) {
        const raw = part.input;
        proposal =
          typeof raw === "string"
            ? (JSON.parse(raw) as ProposeMutationArgs)
            : (raw as ProposeMutationArgs);
        continue; // suppressed — no emit
      }
      emitted.push(...streamPartToAgUiEvents(part as TextStreamPart<ToolSet>));
    }

    // The proposal was captured for the interrupt outcome.
    expect(proposal).toEqual({
      action: "create_product",
      input: { name: "Widget", price: 9.9 },
    });
    // The text frames surfaced; NO TOOL_CALL_* for proposeMutation leaked.
    expect(emitted.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(emitted.some((e) => String(e.type).startsWith("TOOL_CALL"))).toBe(false);
  });
});

// ── buildProposeInterrupt → store + interrupt shape ─────────

describe("buildProposeInterrupt", () => {
  test("writes the store entry and returns the interrupt (Spec 71 §4.2, §6.7)", () => {
    const store = new InMemoryInterruptStore();
    const now = 1_000_000;
    const interrupt = buildProposeInterrupt({
      threadId: "t1",
      proposal: { action: "create_product", input: { name: "Widget", price: 9.9 } },
      proposerActor: HUMAN,
      tenant: "tenant-a",
      store,
      now,
      interruptId: "int-1",
      approvalWindowMs: 600_000,
    });

    // Interrupt shape (§4.2).
    expect(interrupt.id).toBe("int-1");
    expect(interrupt.reason).toBe("action.approval.required");
    expect(interrupt.toolCallId).toBe(`${PROPOSE_MUTATION_TOOL_CALL_ID_PREFIX}int-1`);
    expect(interrupt.expiresAt).toBe(new Date(now + 600_000).toISOString());
    const meta = interrupt.metadata as Record<string, unknown>;
    expect(meta.action).toBe("create_product");
    expect(meta.proposedInput).toEqual({ name: "Widget", price: 9.9 });
    expect(meta.inputDigest).toBe(
      computeInputDigest("create_product", { name: "Widget", price: 9.9 }),
    );

    // Store entry (§6.7) — open, unconsumed, proposer + tenant bound.
    const entry = store.get("t1", "int-1");
    expect(entry).toBeDefined();
    expect(entry?.consumed).toBe(false);
    expect(entry?.actionSet).toEqual(["create_product"]);
    expect(entry?.proposerActor).toEqual({ type: "human", id: "user-1" });
    expect(entry?.tenant).toBe("tenant-a");
    expect(entry?.inputDigest).toBe(meta.inputDigest as string);
  });
});

// ── Endpoint wiring: descriptor → RUN_FINISHED.outcome ──────

describe("POST /api/agui/run — propose half (app.handle)", () => {
  test("a runner returning an interrupt descriptor yields RUN_FINISHED outcome=interrupt", async () => {
    const store = new InMemoryInterruptStore();
    const app = await createAgUiApp({
      aiService: configuredService,
      runner: async ({ input, emit }) => {
        // Simulate a propose run: some assistant text, then the proposal is
        // captured (frames suppressed — we emit NO proposeMutation TOOL_CALL_*).
        emit({ type: EventType.TEXT_MESSAGE_START, messageId: "x1", role: "assistant" });
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "x1", delta: "Proposing…" });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: "x1" });
        const interrupt = buildProposeInterrupt({
          threadId: input.threadId,
          proposal: { action: "create_product", input: { name: "Widget", price: 9.9 } },
          proposerActor: HUMAN,
          tenant: "tenant-a",
          store,
          interruptId: "int-1",
        });
        return { interrupts: [interrupt] };
      },
    });

    const res = await postRun(app, createInput);
    expect(res.status).toBe(200);
    const events = await readSse(res);

    // No raw proposeMutation tool bubble in the stream (§4.5).
    expect(events.some((e) => e.type.startsWith("TOOL_CALL"))).toBe(false);

    // RUN_FINISHED carries the interrupt outcome.
    const finish = events.find((e) => e.type === "RUN_FINISHED");
    expect(finish).toBeDefined();
    const outcome = finish?.outcome as { type: string; interrupts: Array<Record<string, unknown>> };
    expect(outcome.type).toBe("interrupt");
    expect(outcome.interrupts).toHaveLength(1);
    const meta = outcome.interrupts[0]?.metadata as Record<string, unknown>;
    expect(meta.action).toBe("create_product");
    expect(meta.proposedInput).toEqual({ name: "Widget", price: 9.9 });
    expect(meta.inputDigest).toBe(
      computeInputDigest("create_product", { name: "Widget", price: 9.9 }),
    );

    // The interrupt store has the open entry (consumed:false).
    const entry = store.get("t1", "int-1");
    expect(entry?.consumed).toBe(false);
    expect(entry?.proposerActor).toEqual({ type: "human", id: "user-1" });
  });

  test("a read-only runner (returns void) still finishes with a plain success frame", async () => {
    const app = await createAgUiApp({
      aiService: configuredService,
      runner: async ({ emit }) => {
        emit({ type: EventType.TEXT_MESSAGE_START, messageId: "x1", role: "assistant" });
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "x1", delta: "Here you go." });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: "x1" });
        // No proposal — return void.
      },
    });

    const res = await postRun(app, { ...createInput, runId: "rRO" });
    const events = await readSse(res);
    const finish = events.find((e) => e.type === "RUN_FINISHED");
    expect(finish).toBeDefined();
    // Plain finish — byte-identical to the legacy frame (no `outcome` key).
    expect("outcome" in (finish ?? {})).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });
});
