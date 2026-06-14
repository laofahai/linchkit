/**
 * AG-UI ChatTransport translation tests.
 *
 * Pure logic-only (no jsdom): the HttpAgent seam is replaced by an injected
 * synthetic event source (dependency injection — never a global fetch mock),
 * and the emitted `UIMessageChunk` sequences are asserted against the
 * Vercel AI SDK v6 chunk contract that `useChat` consumes.
 */

import { describe, expect, test } from "bun:test";
import type { Interrupt as AgUiInterrupt, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  AgUiChatTransport,
  type AgUiEventSource,
  buildResumeAgentInput,
  buildResumeEntries,
  type InterruptResumeAnswer,
  LK_INTERRUPT_DATA_CHUNK,
  type LkInterruptChunkData,
  PROPOSE_MUTATION_TOOLCALL_PREFIX,
  parseMaybeJson,
  serializeToolOutput,
  streamUiMessageChunks,
  toAgUiContext,
  toAgUiMessages,
} from "../agui-chat-transport";

// ── Helpers ─────────────────────────────────────────────────

/** Synthetic event source: emits the given events asynchronously, then completes. */
function sourceOf(events: BaseEvent[], options?: { error?: unknown }): AgUiEventSource {
  return {
    subscribe(observer) {
      queueMicrotask(() => {
        for (const event of events) observer.next(event);
        if (options && "error" in options) observer.error(options.error);
        else observer.complete();
      });
      return { unsubscribe: () => {} };
    },
  };
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/** AG-UI event literals (typed loosely as the wire BaseEvent). */
function ev(event: Record<string, unknown>): BaseEvent {
  return event as unknown as BaseEvent;
}

const RUN_STARTED = ev({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" });
const RUN_FINISHED = ev({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" });

// ── AG-UI events → UIMessageChunk ───────────────────────────

describe("streamUiMessageChunks — text streaming", () => {
  test("translates RUN_STARTED → text events → RUN_FINISHED", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
          ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hel" }),
          ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "lo" }),
          ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
          RUN_FINISHED,
        ]),
      ),
    );

    expect(chunks).toEqual([
      { type: "start" },
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "Hel" },
      { type: "text-delta", id: "m1", delta: "lo" },
      { type: "text-end", id: "m1" },
      { type: "finish" },
    ]);
  });

  test("ignores protocol events without a UI chunk counterpart", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({ type: EventType.STEP_STARTED, stepName: "s1" }),
          ev({ type: EventType.STATE_SNAPSHOT, snapshot: {} }),
          ev({ type: EventType.STEP_FINISHED, stepName: "s1" }),
          RUN_FINISHED,
        ]),
      ),
    );
    expect(chunks).toEqual([{ type: "start" }, { type: "finish" }]);
  });
});

describe("streamUiMessageChunks — tool call sequence", () => {
  test("translates TOOL_CALL_START/ARGS/END/RESULT into tool-input/output chunks", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "queryRecords" }),
          ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '{"entity":' }),
          ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '"order"}' }),
          ev({ type: EventType.TOOL_CALL_END, toolCallId: "tc1" }),
          ev({
            type: EventType.TOOL_CALL_RESULT,
            messageId: "m2",
            toolCallId: "tc1",
            content: '[{"id":"o1"}]',
            role: "tool",
          }),
          RUN_FINISHED,
        ]),
      ),
    );

    expect(chunks).toEqual([
      { type: "start" },
      { type: "tool-input-start", toolCallId: "tc1", toolName: "queryRecords" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '{"entity":' },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '"order"}' },
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "queryRecords",
        input: { entity: "order" },
      },
      { type: "tool-output-available", toolCallId: "tc1", output: [{ id: "o1" }] },
      { type: "finish" },
    ]);
  });

  test("an args-less tool call yields an empty-object input", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "listEntities" }),
          ev({ type: EventType.TOOL_CALL_END, toolCallId: "tc1" }),
          RUN_FINISHED,
        ]),
      ),
    );
    expect(chunks[2]).toEqual({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "listEntities",
      input: {},
    });
  });

  test("non-JSON tool result content is passed through as a string", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          ev({
            type: EventType.TOOL_CALL_RESULT,
            messageId: "m1",
            toolCallId: "tc1",
            content: "plain text result",
          }),
        ]),
      ),
    );
    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "tc1", output: "plain text result" },
    ]);
  });
});

describe("streamUiMessageChunks — failures", () => {
  test("RUN_ERROR becomes an error chunk (and no finish)", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([RUN_STARTED, ev({ type: EventType.RUN_ERROR, message: "provider exploded" })]),
      ),
    );
    expect(chunks).toEqual([{ type: "start" }, { type: "error", errorText: "provider exploded" }]);
  });

  test("a transport-level error becomes an error chunk", async () => {
    const chunks = await collect(
      streamUiMessageChunks(sourceOf([RUN_STARTED], { error: new Error("boom") })),
    );
    expect(chunks).toEqual([{ type: "start" }, { type: "error", errorText: "boom" }]);
  });

  test("an abort error closes the stream WITHOUT an error chunk (user stop)", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const chunks = await collect(
      streamUiMessageChunks(sourceOf([RUN_STARTED], { error: abortError })),
    );
    expect(chunks).toEqual([{ type: "start" }]);
  });
});

// ── Tool output round-trip (serialize → parse) ──────────────

describe("serializeToolOutput / parseMaybeJson round-trip", () => {
  test("string outputs survive the round-trip without type mutation", () => {
    // Before the symmetric contract, "123" came back as the number 123 and
    // "true" as a boolean — every string must round-trip as the SAME string.
    for (const original of ["123", "true", '{"a":1}']) {
      expect(parseMaybeJson(serializeToolOutput(original))).toBe(original);
    }
  });

  test("object outputs survive the round-trip structurally", () => {
    const original = { a: 1, nested: { ok: true }, list: [1, "2"] };
    expect(parseMaybeJson(serializeToolOutput(original))).toEqual(original);
  });

  test("plain non-JSON text from a foreign agent falls back to the raw string", () => {
    // Third-party AG-UI agents may send unencoded plain text — the decoder
    // must tolerate it instead of throwing.
    expect(parseMaybeJson("plain text from another agent")).toBe("plain text from another agent");
  });

  test("a string tool output is JSON-encoded on the AG-UI wire", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-getRecord",
            toolCallId: "tc1",
            state: "output-available",
            input: { id: "x" },
            output: "123",
          },
        ],
      },
    ];
    const mapped = toAgUiMessages(messages);
    expect(mapped[1]).toMatchObject({ role: "tool", content: '"123"' });
  });
});

// ── UIMessage[] → AG-UI messages ────────────────────────────

describe("toAgUiMessages", () => {
  test("maps user/assistant text history", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi there" }] },
    ];
    expect(toAgUiMessages(messages)).toEqual([
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "hi there" },
    ]);
  });

  test("maps completed tool invocations to toolCalls + tool result messages", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "list orders" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Found these:" },
          {
            type: "tool-queryRecords",
            toolCallId: "tc1",
            state: "output-available",
            input: { entity: "order" },
            output: [{ id: "o1" }],
          },
        ],
      },
    ];

    expect(toAgUiMessages(messages)).toEqual([
      { id: "u1", role: "user", content: "list orders" },
      {
        id: "a1",
        role: "assistant",
        content: "Found these:",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "queryRecords", arguments: '{"entity":"order"}' },
          },
        ],
      },
      { id: "tc1_result", role: "tool", toolCallId: "tc1", content: '[{"id":"o1"}]' },
    ]);
  });

  test("maps a failed tool invocation to a tool message carrying the error", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-getRecord",
            toolCallId: "tc1",
            state: "output-error",
            input: { id: "x" },
            errorText: "not found",
          },
        ],
      },
    ];

    const mapped = toAgUiMessages(messages);
    expect(mapped).toHaveLength(2);
    expect(mapped[1]).toEqual({
      id: "tc1_result",
      role: "tool",
      toolCallId: "tc1",
      content: "not found",
      error: "not found",
    });
  });

  test("tolerates messages without parts (persisted/external state)", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ] as unknown as UIMessage[];
    expect(toAgUiMessages(messages)).toEqual([]);
  });

  test("skips in-flight tool invocations and empty messages", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-queryRecords",
            toolCallId: "tc1",
            state: "input-streaming",
            input: undefined,
          },
        ],
      },
      { id: "u1", role: "user", parts: [] },
    ];
    expect(toAgUiMessages(messages)).toEqual([]);
  });

  test("skips input-available frontend tool calls (no result ever arrives)", () => {
    // `input-available` is terminal for execute-less frontend tools. Sending
    // the call without a tool-result message is an invalid conversation for
    // strict providers, so it must not enter the history.
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Opening the form." },
          {
            type: "tool-openForm",
            toolCallId: "tc1",
            state: "input-available",
            input: { entity: "order" },
          },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] },
    ];
    expect(toAgUiMessages(messages)).toEqual([
      { id: "a1", role: "assistant", content: "Opening the form." },
      { id: "u2", role: "user", content: "thanks" },
    ]);
  });
});

// ── Transport end-to-end (DI seam) ──────────────────────────

describe("AgUiChatTransport", () => {
  test("sendMessages builds a RunAgentInput and streams translated chunks", async () => {
    const inputs: RunAgentInput[] = [];
    const transport = new AgUiChatTransport({
      context: () => ({ entity: "order", recordId: "o1", locale: "zh-CN" }),
      runAgent: (input) => {
        inputs.push(input);
        return sourceOf([
          RUN_STARTED,
          ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
          ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "OK" }),
          ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
          RUN_FINISHED,
        ]);
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat_1",
      messageId: undefined,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      abortSignal: undefined,
    });
    const chunks = await collect(stream);

    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input?.threadId).toBe("chat_1");
    expect(typeof input?.runId).toBe("string");
    expect(input?.messages).toEqual([{ id: "u1", role: "user", content: "hello" }]);
    expect(input?.tools).toEqual([]);
    expect(input?.context).toEqual([
      { description: "entity", value: "order" },
      { description: "recordId", value: "o1" },
      { description: "locale", value: "zh-CN" },
    ]);

    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("reconnectToStream resolves null (AG-UI runs are not resumable)", async () => {
    const transport = new AgUiChatTransport({ runAgent: () => sourceOf([]) });
    expect(await transport.reconnectToStream({ chatId: "chat_1" })).toBeNull();
  });
});

describe("toAgUiContext", () => {
  test("emits only the entries that are present", () => {
    expect(toAgUiContext(undefined)).toEqual([]);
    expect(toAgUiContext({})).toEqual([]);
    expect(toAgUiContext({ locale: "en" })).toEqual([{ description: "locale", value: "en" }]);
  });
});

// ── AG-UI HITL interrupt branch (Spec 71 §4.5) ──────────────

/** A well-formed action-approval interrupt as the server emits it. */
const SAMPLE_INTERRUPT: AgUiInterrupt = {
  id: "int_1",
  reason: "action.approval.required",
  toolCallId: "lk:propose-mutation:int_1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  metadata: {
    action: "create_product",
    proposedInput: { name: "Widget", price: 9.9 },
    inputSchema: { name: { type: "string", required: true } },
    actionLabel: "Create product",
    inputDigest: "digest_abc",
  },
};

describe("createAgUiChunkTranslator — interrupt branch", () => {
  test("RUN_FINISHED with an interrupt outcome surfaces an interrupt chunk (not a plain finish)", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.RUN_FINISHED,
            threadId: "t1",
            runId: "r1",
            outcome: { type: "interrupt", interrupts: [SAMPLE_INTERRUPT] },
          }),
        ]),
      ),
    );

    // The interrupt chunk is emitted, carrying the interrupt id + metadata, and
    // a finish still follows so the assistant turn terminates.
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: "start" });
    const interruptChunk = chunks[1] as {
      type: string;
      data: LkInterruptChunkData;
      transient?: boolean;
    };
    expect(interruptChunk.type).toBe(LK_INTERRUPT_DATA_CHUNK);
    expect(interruptChunk.transient).toBe(true);
    expect(interruptChunk.data.interrupts).toHaveLength(1);
    expect(interruptChunk.data.interrupts[0]?.id).toBe("int_1");
    expect(interruptChunk.data.interrupts[0]?.metadata?.inputDigest).toBe("digest_abc");
    expect(chunks[2]).toEqual({ type: "finish" });
  });

  test("a plain RUN_FINISHED (no outcome) still emits only a finish", async () => {
    const chunks = await collect(streamUiMessageChunks(sourceOf([RUN_STARTED, RUN_FINISHED])));
    expect(chunks).toEqual([{ type: "start" }, { type: "finish" }]);
  });

  test("a RUN_FINISHED with a success outcome still emits only a finish", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.RUN_FINISHED,
            threadId: "t1",
            runId: "r1",
            outcome: { type: "success" },
          }),
        ]),
      ),
    );
    expect(chunks).toEqual([{ type: "start" }, { type: "finish" }]);
  });

  test("an interrupt outcome with an empty interrupts list falls back to a plain finish", async () => {
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.RUN_FINISHED,
            threadId: "t1",
            runId: "r1",
            outcome: { type: "interrupt", interrupts: [] },
          }),
        ]),
      ),
    );
    expect(chunks).toEqual([{ type: "start" }, { type: "finish" }]);
  });
});

// ── Fallback reserved-prefix drop (Spec 71 §4.5) ────────────

describe("createAgUiChunkTranslator — reserved-prefix tool-call drop", () => {
  test("a stray lk:propose-mutation:* tool-call is dropped (no chunk)", async () => {
    const strayId = `${PROPOSE_MUTATION_TOOLCALL_PREFIX}int_1`;
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.TOOL_CALL_START,
            toolCallId: strayId,
            toolCallName: "proposeMutation",
          }),
          ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: strayId, delta: '{"action":"x"}' }),
          ev({ type: EventType.TOOL_CALL_END, toolCallId: strayId }),
          RUN_FINISHED,
        ]),
      ),
    );
    // Only start + finish — every propose-mutation tool-call frame is suppressed
    // stream-time as it arrives, so no tool bubble can render.
    expect(chunks).toEqual([{ type: "start" }, { type: "finish" }]);
  });

  test("a normal tool-call id is still translated alongside a dropped propose-mutation one", async () => {
    const strayId = `${PROPOSE_MUTATION_TOOLCALL_PREFIX}int_2`;
    const chunks = await collect(
      streamUiMessageChunks(
        sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.TOOL_CALL_START,
            toolCallId: strayId,
            toolCallName: "proposeMutation",
          }),
          ev({ type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "queryRecords" }),
          ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: strayId, delta: '{"a":1}' }),
          ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '{"entity":"order"}' }),
          ev({ type: EventType.TOOL_CALL_END, toolCallId: strayId }),
          ev({ type: EventType.TOOL_CALL_END, toolCallId: "tc1" }),
          RUN_FINISHED,
        ]),
      ),
    );
    expect(chunks).toEqual([
      { type: "start" },
      { type: "tool-input-start", toolCallId: "tc1", toolName: "queryRecords" },
      { type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: '{"entity":"order"}' },
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "queryRecords",
        input: { entity: "order" },
      },
      { type: "finish" },
    ]);
  });
});

// ── Resume round-trip RunAgentInput (Spec 71 §3.4 / §4.2) ────

describe("buildResumeEntries + buildResumeAgentInput", () => {
  test("a resolved answer produces a resume entry with { action, input, baseDigest }", () => {
    const answers: Record<string, InterruptResumeAnswer> = {
      int_1: {
        status: "resolved",
        payload: {
          action: "create_product",
          input: { name: "X", price: 8.9 },
          baseDigest: "digest_abc",
        },
      },
    };
    const entries = buildResumeEntries([SAMPLE_INTERRUPT], answers);
    expect(entries).toEqual([
      {
        interruptId: "int_1",
        status: "resolved",
        payload: {
          action: "create_product",
          input: { name: "X", price: 8.9 },
          baseDigest: "digest_abc",
        },
      },
    ]);
  });

  test("a cancelled answer produces a resume entry with no payload", () => {
    const answers: Record<string, InterruptResumeAnswer> = {
      int_1: { status: "cancelled" },
    };
    const entries = buildResumeEntries([SAMPLE_INTERRUPT], answers);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.interruptId).toBe("int_1");
    expect(entries[0]?.status).toBe("cancelled");
    expect(entries[0]?.payload).toBeUndefined();
  });

  test("buildResumeAgentInput threads resume + reuses the same threadId with a fresh runId", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "make X" }] },
    ];
    const resume = buildResumeEntries([SAMPLE_INTERRUPT], {
      int_1: {
        status: "resolved",
        payload: { action: "create_product", input: { name: "X" }, baseDigest: "digest_abc" },
      },
    });
    const input = buildResumeAgentInput({
      threadId: "chat_1",
      messages,
      resume,
      context: [{ description: "entity", value: "product" }],
    });
    expect(input.threadId).toBe("chat_1");
    expect(typeof input.runId).toBe("string");
    expect(input.runId.length).toBeGreaterThan(0);
    expect(input.messages).toEqual([{ id: "u1", role: "user", content: "make X" }]);
    expect(input.tools).toEqual([]);
    expect(input.context).toEqual([{ description: "entity", value: "product" }]);
    expect(input.resume).toEqual(resume);
  });
});

// ── Transport.sendResume (DI seam) ──────────────────────────

describe("AgUiChatTransport.sendResume", () => {
  test("builds a resume RunAgentInput and streams the result back", async () => {
    const inputs: RunAgentInput[] = [];
    const transport = new AgUiChatTransport({
      context: () => ({ entity: "product" }),
      runAgent: (input) => {
        inputs.push(input);
        return sourceOf([
          RUN_STARTED,
          ev({
            type: EventType.TOOL_CALL_RESULT,
            messageId: "m1",
            toolCallId: "lk:propose-mutation:int_1",
            content: JSON.stringify({ success: true, action: "create_product", executionId: "e1" }),
            role: "tool",
          }),
          RUN_FINISHED,
        ]);
      },
    });

    const stream = await transport.sendResume({
      chatId: "chat_1",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "make X" }] }],
      interrupts: [SAMPLE_INTERRUPT],
      answers: {
        int_1: {
          status: "resolved",
          payload: { action: "create_product", input: { name: "X" }, baseDigest: "digest_abc" },
        },
      },
    });
    const chunks = await collect(stream);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.threadId).toBe("chat_1");
    expect(inputs[0]?.resume).toEqual([
      {
        interruptId: "int_1",
        status: "resolved",
        payload: { action: "create_product", input: { name: "X" }, baseDigest: "digest_abc" },
      },
    ]);
    // The server's TOOL_CALL_RESULT for the reserved id is translated to a
    // tool-output chunk (the resume run's result reaches the chat).
    expect(chunks.map((c) => c.type)).toEqual(["start", "tool-output-available", "finish"]);
  });
});
