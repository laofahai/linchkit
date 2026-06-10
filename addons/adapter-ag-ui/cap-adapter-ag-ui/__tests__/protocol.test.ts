import { describe, expect, test } from "bun:test";
import { EventType, encodeSseEvent, runAgentInputSchema } from "../src/protocol";

describe("runAgentInputSchema", () => {
  test("accepts a minimal input and fills array defaults", () => {
    const parsed = runAgentInputSchema.parse({ threadId: "thread_1", runId: "run_1" });

    expect(parsed.threadId).toBe("thread_1");
    expect(parsed.runId).toBe("run_1");
    expect(parsed.messages).toEqual([]);
    expect(parsed.tools).toEqual([]);
    expect(parsed.context).toEqual([]);
  });

  test("accepts a full input with messages, tools and context", () => {
    const parsed = runAgentInputSchema.parse({
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

  test("rejects missing threadId / runId", () => {
    expect(runAgentInputSchema.safeParse({ runId: "run_1" }).success).toBe(false);
    expect(runAgentInputSchema.safeParse({ threadId: "thread_1" }).success).toBe(false);
    expect(runAgentInputSchema.safeParse({ threadId: "", runId: "run_1" }).success).toBe(false);
  });

  test("rejects messages with an unknown role", () => {
    const result = runAgentInputSchema.safeParse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [{ id: "msg_1", role: "alien", content: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects user messages without string content", () => {
    const result = runAgentInputSchema.safeParse({
      threadId: "thread_1",
      runId: "run_1",
      messages: [{ id: "msg_1", role: "user", content: 42 }],
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
    expect(EventType.RUN_STARTED).toBe("RUN_STARTED");
    expect(EventType.RUN_FINISHED).toBe("RUN_FINISHED");
    expect(EventType.RUN_ERROR).toBe("RUN_ERROR");
    expect(EventType.TEXT_MESSAGE_START).toBe("TEXT_MESSAGE_START");
    expect(EventType.TEXT_MESSAGE_CONTENT).toBe("TEXT_MESSAGE_CONTENT");
    expect(EventType.TEXT_MESSAGE_END).toBe("TEXT_MESSAGE_END");
    expect(EventType.TOOL_CALL_START).toBe("TOOL_CALL_START");
    expect(EventType.TOOL_CALL_ARGS).toBe("TOOL_CALL_ARGS");
    expect(EventType.TOOL_CALL_END).toBe("TOOL_CALL_END");
    expect(EventType.STATE_SNAPSHOT).toBe("STATE_SNAPSHOT");
    expect(EventType.CUSTOM).toBe("CUSTOM");
  });
});
