/**
 * AG-UI main-server route + assistant runner translation tests.
 *
 * Route tests use `app.handle(new Request(...))` (in-process, port-free —
 * never `app.listen`). The AI seam is a fake injected `AIService`; no global
 * fetch mocks. The streamText-based runner itself is exercised through its
 * pure translation helpers (message mapping + fullStream-part translation),
 * which carry all the protocol-mapping logic.
 */

import { describe, expect, test } from "bun:test";
import type { Message as AgUiMessage } from "@linchkit/cap-adapter-ag-ui";
import { EventType } from "@linchkit/cap-adapter-ag-ui";
import type { AIService, AIStreamResult, CapabilityDefinition } from "@linchkit/core";
import type { TextStreamPart, ToolSet } from "ai";
import { Elysia } from "elysia";
import {
  agUiContextValue,
  streamPartToAgUiEvents,
  toModelMessagesFromAgUi,
} from "../../ai/agui-runner";
import { AG_UI_RUN_PATH, hasAgUiCapability, mountAgUiRoutes } from "../agui-api";

const RUN_URL = `http://local.test${AG_UI_RUN_PATH}`;

const AG_UI_CAPABILITY: CapabilityDefinition = {
  name: "cap-adapter-ag-ui",
  label: "AG-UI Server",
  description: "test stub",
  type: "adapter",
  category: "integration",
  version: "0.0.1",
};

const validInput = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "m1", role: "user", content: "hello" }],
  tools: [],
  context: [],
};

function postRun(app: Elysia, body: unknown) {
  return app.handle(
    new Request(RUN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Fake AIService with token streaming (drives the default bridge path). */
function fakeStreamingService(chunks: string[]): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async () => {
      throw new Error("complete() should not be called on the streaming path");
    },
    completeStream: async (): Promise<AIStreamResult> => ({
      textStream: (async function* () {
        yield* chunks;
      })(),
      model: "fake-model",
      provider: "fake",
    }),
  };
}

// ── Route mounting ──────────────────────────────────────────

describe("mountAgUiRoutes", () => {
  test("does NOT mount the route when cap-adapter-ag-ui is not registered", async () => {
    const app = mountAgUiRoutes(new Elysia(), { capabilities: [] });
    const res = await postRun(app, validInput);
    expect(res.status).toBe(404);
    expect(hasAgUiCapability({ capabilities: [] })).toBe(false);
  });

  test("mounts the route when the capability is registered (503 without AI)", async () => {
    const app = mountAgUiRoutes(new Elysia(), { capabilities: [AG_UI_CAPABILITY] });
    const res = await postRun(app, validInput);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.error.message).toContain("AI service is not configured");
  });

  test("streams AG-UI events through the default bridge when configured (no aiConfig)", async () => {
    const app = mountAgUiRoutes(new Elysia(), {
      capabilities: [AG_UI_CAPABILITY],
      aiService: fakeStreamingService(["Hi", "!"]),
    });
    const res = await postRun(app, validInput);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = (await res.text())
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter((frame) => frame.length > 0)
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as { type: string });
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  test("rejects an invalid RunAgentInput with 400 before availability", async () => {
    const app = mountAgUiRoutes(new Elysia(), { capabilities: [AG_UI_CAPABILITY] });
    const res = await postRun(app, { nonsense: true });
    expect(res.status).toBe(400);
  });
});

// ── AG-UI history → ModelMessage[] ──────────────────────────

describe("toModelMessagesFromAgUi", () => {
  test("maps roles, tool calls, and tool results faithfully", () => {
    const messages: AgUiMessage[] = [
      { id: "m1", role: "system", content: "be brief" },
      { id: "m2", role: "user", content: "list orders" },
      {
        id: "m3",
        role: "assistant",
        content: "checking",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "queryRecords", arguments: '{"entity":"order"}' },
          },
        ],
      },
      { id: "m4", role: "tool", toolCallId: "tc1", content: '[{"id":"o1"}]' },
      { id: "m5", role: "user", content: "thanks" },
    ];

    expect(toModelMessagesFromAgUi(messages)).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "list orders" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "queryRecords",
            input: { entity: "order" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "queryRecords",
            output: { type: "text", value: '[{"id":"o1"}]' },
          },
        ],
      },
      { role: "user", content: "thanks" },
    ]);
  });

  test("keeps multimodal user text parts and drops empty/structural messages", () => {
    const messages: AgUiMessage[] = [
      {
        id: "m1",
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { id: "m2", role: "assistant" },
    ];
    expect(toModelMessagesFromAgUi(messages)).toEqual([{ role: "user", content: "first\nsecond" }]);
  });
});

// ── streamText fullStream → AG-UI events ────────────────────

describe("streamPartToAgUiEvents", () => {
  test("translates the text triple", () => {
    expect(
      streamPartToAgUiEvents({ type: "text-start", id: "t1" } as TextStreamPart<ToolSet>),
    ).toEqual([{ type: EventType.TEXT_MESSAGE_START, messageId: "t1", role: "assistant" }]);
    expect(
      streamPartToAgUiEvents({
        type: "text-delta",
        id: "t1",
        text: "Hi",
      } as TextStreamPart<ToolSet>),
    ).toEqual([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "t1", delta: "Hi" }]);
    // Protocol requires non-empty deltas — empty ones are dropped.
    expect(
      streamPartToAgUiEvents({ type: "text-delta", id: "t1", text: "" } as TextStreamPart<ToolSet>),
    ).toEqual([]);
    expect(
      streamPartToAgUiEvents({ type: "text-end", id: "t1" } as TextStreamPart<ToolSet>),
    ).toEqual([{ type: EventType.TEXT_MESSAGE_END, messageId: "t1" }]);
  });

  test("translates a tool call into a consolidated START → ARGS → END triple", () => {
    const events = streamPartToAgUiEvents({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "queryRecords",
      input: { entity: "order" },
    } as TextStreamPart<ToolSet>);
    expect(events).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "queryRecords" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: '{"entity":"order"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
    ]);
  });

  test("translates a server-side tool result into TOOL_CALL_RESULT", () => {
    const events = streamPartToAgUiEvents({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "queryRecords",
      input: {},
      output: { count: 2 },
    } as TextStreamPart<ToolSet>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "TOOL_CALL_RESULT",
      toolCallId: "tc1",
      content: '{"count":2}',
      role: "tool",
    });
  });

  test("throws on an error part (run endpoint maps it to RUN_ERROR)", () => {
    expect(() =>
      streamPartToAgUiEvents({
        type: "error",
        error: new Error("model died"),
      } as TextStreamPart<ToolSet>),
    ).toThrow("model died");
  });

  test("ignores structural parts (steps, tool-input streaming, finish)", () => {
    for (const type of ["start", "start-step", "finish-step", "tool-input-start"] as const) {
      expect(streamPartToAgUiEvents({ type } as unknown as TextStreamPart<ToolSet>)).toEqual([]);
    }
  });
});

// ── Context extraction ──────────────────────────────────────

describe("agUiContextValue", () => {
  test("reads well-known entries and tolerates absences", () => {
    const input = {
      context: [
        { description: "entity", value: "order" },
        { description: "locale", value: "zh-CN" },
      ],
    };
    expect(agUiContextValue(input, "entity")).toBe("order");
    expect(agUiContextValue(input, "locale")).toBe("zh-CN");
    expect(agUiContextValue(input, "recordId")).toBeUndefined();
    expect(agUiContextValue({ context: [] }, "entity")).toBeUndefined();
  });
});
