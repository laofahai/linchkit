import { describe, expect, test } from "bun:test";
import { EventType, encodeSseEvent, RunAgentInputSchema } from "../src/protocol";

describe("RunAgentInputSchema (official @ag-ui/core schema)", () => {
  test("rejects a minimal input missing the required arrays", () => {
    // Upstream requires `messages`, `tools` and `context` — no defaults.
    const result = RunAgentInputSchema.safeParse({ threadId: "thread_1", runId: "run_1" });
    expect(result.success).toBe(false);
  });

  test("accepts an input with explicit (empty) required arrays", () => {
    const parsed = RunAgentInputSchema.parse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [],
      tools: [],
      context: [],
    });

    expect(parsed.threadId).toBe("thread_1");
    expect(parsed.runId).toBe("run_1");
    expect(parsed.messages).toEqual([]);
    expect(parsed.tools).toEqual([]);
    expect(parsed.context).toEqual([]);
  });

  test("accepts a full input with messages, tools and context", () => {
    const parsed = RunAgentInputSchema.parse({
      threadId: "thread_1",
      runId: "run_1",
      state: { counter: 1 },
      messages: [
        { id: "msg_1", role: "system", content: "You are helpful." },
        { id: "msg_2", role: "user", content: "Hello" },
        {
          id: "msg_3",
          role: "assistant",
          toolCalls: [
            { id: "tc_1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { id: "msg_4", role: "tool", content: "result", toolCallId: "tc_1" },
      ],
      tools: [
        {
          name: "confirm_order",
          description: "Ask the user to confirm",
          parameters: { type: "object", properties: {} },
        },
      ],
      context: [{ description: "page", value: "/orders" }],
      forwardedProps: { foo: "bar" },
    });

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.tools[0]?.name).toBe("confirm_order");
    expect(parsed.context[0]?.value).toBe("/orders");
  });

  test("accepts multimodal user content (InputContent[] text parts)", () => {
    const parsed = RunAgentInputSchema.parse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [
        { id: "msg_1", role: "user", content: [{ type: "text", text: "Hello from a part" }] },
      ],
      tools: [],
      context: [],
    });
    expect(parsed.messages).toHaveLength(1);
  });

  test("rejects missing threadId / runId", () => {
    const arrays = { messages: [], tools: [], context: [] };
    expect(RunAgentInputSchema.safeParse({ runId: "run_1", ...arrays }).success).toBe(false);
    expect(RunAgentInputSchema.safeParse({ threadId: "thread_1", ...arrays }).success).toBe(false);
  });

  test("rejects messages with an unknown role", () => {
    const result = RunAgentInputSchema.safeParse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [{ id: "msg_1", role: "alien", content: "hi" }],
      tools: [],
      context: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects user messages with non-string, non-part content", () => {
    const result = RunAgentInputSchema.safeParse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [{ id: "msg_1", role: "user", content: 42 }],
      tools: [],
      context: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("encodeSseEvent", () => {
  test("frames an event as `data: <json>\\n\\n`", () => {
    const frame = encodeSseEvent({
      type: EventType.RUN_STARTED,
      threadId: "thread_1",
      runId: "run_1",
    });

    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice("data: ".length))).toEqual({
      type: "RUN_STARTED",
      threadId: "thread_1",
      runId: "run_1",
    });
  });
});

describe("EventType", () => {
  test("uses the exact protocol string values", () => {
    // String() unwraps the upstream enum so we compare wire values.
    expect(String(EventType.RUN_STARTED)).toBe("RUN_STARTED");
    expect(String(EventType.RUN_FINISHED)).toBe("RUN_FINISHED");
    expect(String(EventType.RUN_ERROR)).toBe("RUN_ERROR");
    expect(String(EventType.TEXT_MESSAGE_START)).toBe("TEXT_MESSAGE_START");
    expect(String(EventType.TEXT_MESSAGE_CONTENT)).toBe("TEXT_MESSAGE_CONTENT");
    expect(String(EventType.TEXT_MESSAGE_END)).toBe("TEXT_MESSAGE_END");
    expect(String(EventType.TOOL_CALL_START)).toBe("TOOL_CALL_START");
    expect(String(EventType.TOOL_CALL_ARGS)).toBe("TOOL_CALL_ARGS");
    expect(String(EventType.TOOL_CALL_END)).toBe("TOOL_CALL_END");
    expect(String(EventType.STATE_SNAPSHOT)).toBe("STATE_SNAPSHOT");
    expect(String(EventType.CUSTOM)).toBe("CUSTOM");
  });
});
