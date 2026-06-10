/**
 * AG-UI ChatTransport translation tests.
 *
 * Pure logic-only (no jsdom): the HttpAgent seam is replaced by an injected
 * synthetic event source (dependency injection — never a global fetch mock),
 * and the emitted `UIMessageChunk` sequences are asserted against the
 * Vercel AI SDK v6 chunk contract that `useChat` consumes.
 */

import { describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  AgUiChatTransport,
  type AgUiEventSource,
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
