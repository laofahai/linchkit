/**
 * AG-UI run endpoint tests.
 *
 * Uses `app.handle(new Request(...))` (in-process, port-free) — never
 * `app.listen`. The AI assistant seam is stubbed by injecting fake
 * `AIService` implementations (no global fetch mocks).
 */

import { describe, expect, test } from "bun:test";
import type { AICompletionResult, AIService, AIStreamResult } from "@linchkit/core";
import {
  type AGUIEvent,
  EventType,
  makeInterruptOutcome,
  RunFinishedEventSchema,
} from "../src/protocol";
import { createAgUiApp, makeRunFinishedEvent } from "../src/run-endpoint";

const RUN_URL = "http://local.test/api/agui/run";

function postRun(app: { handle: (request: Request) => Promise<Response> }, body: unknown) {
  return app.handle(
    new Request(RUN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Parse an SSE body (`data: <json>\n\n` frames) into protocol events. */
function parseSseEvents(text: string): AGUIEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return JSON.parse(frame.slice("data: ".length)) as AGUIEvent;
    });
}

/** Event type discriminators as plain wire strings (enum-free comparisons). */
function eventTypes(events: AGUIEvent[]): string[] {
  return events.map((e) => String(e.type));
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Fake AIService: deterministic text + one tool call via `complete`. */
function fakeCompleteService(result?: Partial<AICompletionResult>): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async () => ({
      content: "Hello from LinchKit",
      toolCalls: [{ toolName: "confirm_order", args: { orderId: "ord_1" } }],
      usage,
      model: "fake-model",
      provider: "fake",
      duration: 1,
      ...result,
    }),
  };
}

/** Fake AIService with token-level streaming (used when no tools requested). */
function fakeStreamingService(chunks: string[]): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    complete: async () => {
      throw new Error("complete() must not be called when completeStream is available");
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

const validInput = {
  threadId: "thread_1",
  runId: "run_1",
  messages: [{ id: "msg_1", role: "user", content: "Create an order" }],
  tools: [
    {
      name: "confirm_order",
      description: "Ask the user to confirm the order",
      parameters: { type: "object", properties: { orderId: { type: "string" } } },
    },
  ],
  context: [{ description: "current page", value: "/orders" }],
};

describe("POST /api/agui/run — availability", () => {
  test("returns the ai-api 503 contract when no AI service is injected", async () => {
    const app = await createAgUiApp({});
    const res = await postRun(app, validInput);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toBe(
      "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable the assistant.",
    );
  });

  test("returns 503 when the AI service is present but not configured", async () => {
    const noop: AIService = {
      configured: false,
      defaultProvider: null,
      providerNames: [],
      complete: async () => {
        throw new Error("not configured");
      },
    };
    const app = await createAgUiApp({ aiService: noop });
    const res = await postRun(app, validInput);

    expect(res.status).toBe(503);
  });
});

describe("POST /api/agui/run — input validation", () => {
  test("rejects garbage input with 400", async () => {
    const app = await createAgUiApp({ aiService: fakeCompleteService() });
    const res = await postRun(app, { nonsense: true });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain("Invalid RunAgentInput");
  });

  test("rejects a message with an invalid role with 400", async () => {
    const app = await createAgUiApp({ aiService: fakeCompleteService() });
    const res = await postRun(app, {
      ...validInput,
      messages: [{ id: "msg_1", role: "alien", content: "hi" }],
    });

    expect(res.status).toBe(400);
  });

  test("rejects input missing the required messages/tools/context arrays with 400", async () => {
    // The official @ag-ui/core RunAgentInputSchema requires all three arrays.
    const app = await createAgUiApp({ aiService: fakeCompleteService() });
    const res = await postRun(app, { threadId: "thread_1", runId: "run_1" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.error.message).toContain("Invalid RunAgentInput");
  });

  test("validation runs before the availability check (400 wins over 503)", async () => {
    const app = await createAgUiApp({});
    const res = await postRun(app, { nonsense: true });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/agui/run — happy path (text + tool call)", () => {
  test("streams a valid AG-UI event sequence over SSE", async () => {
    const app = await createAgUiApp({ aiService: fakeCompleteService() });
    const res = await postRun(app, validInput);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);

    // RUN_STARTED / RUN_FINISHED echo the thread/run identifiers
    const [runStarted] = events;
    const runFinished = events.at(-1);
    expect(runStarted).toMatchObject({ threadId: "thread_1", runId: "run_1" });
    expect(runFinished).toMatchObject({ threadId: "thread_1", runId: "run_1" });

    // Text message events share one messageId and carry the deterministic text
    const start = events[1] as { messageId: string; role: string };
    const content = events[2] as { messageId: string; delta: string };
    const end = events[3] as { messageId: string };
    expect(start.role).toBe("assistant");
    expect(content.delta).toBe("Hello from LinchKit");
    expect(new Set([start.messageId, content.messageId, end.messageId]).size).toBe(1);

    // Tool call events share one toolCallId and carry JSON-encoded args
    const tcStart = events[4] as { toolCallId: string; toolCallName: string };
    const tcArgs = events[5] as { toolCallId: string; delta: string };
    const tcEnd = events[6] as { toolCallId: string };
    expect(tcStart.toolCallName).toBe("confirm_order");
    expect(JSON.parse(tcArgs.delta)).toEqual({ orderId: "ord_1" });
    expect(new Set([tcStart.toolCallId, tcArgs.toolCallId, tcEnd.toolCallId]).size).toBe(1);
  });

  test("omits text message events when the model returns no content", async () => {
    const app = await createAgUiApp({ aiService: fakeCompleteService({ content: "" }) });
    const res = await postRun(app, validInput);

    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
  });
});

describe("POST /api/agui/run — streaming path (no tools)", () => {
  test("uses completeStream and emits one TEXT_MESSAGE_CONTENT per chunk", async () => {
    const app = await createAgUiApp({ aiService: fakeStreamingService(["Hel", "lo", "!"]) });
    const res = await postRun(app, {
      threadId: "thread_2",
      runId: "run_2",
      messages: [{ id: "msg_1", role: "user", content: "Say hello" }],
      tools: [],
      context: [],
    });

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const deltas = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as { delta: string }).delta);
    expect(deltas.join("")).toBe("Hello!");
  });
});

describe("POST /api/agui/run — failure mid-run", () => {
  test("emits RUN_ERROR (and no RUN_FINISHED) when the AI service throws", async () => {
    const failing: AIService = {
      configured: true,
      defaultProvider: "fake",
      providerNames: ["fake"],
      complete: async () => {
        throw new Error("provider exploded");
      },
    };
    const app = await createAgUiApp({ aiService: failing });
    const res = await postRun(app, {
      threadId: "thread_3",
      runId: "run_3",
      messages: [],
      tools: [],
      context: [],
    });

    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    expect(events[1]).toMatchObject({ message: "provider exploded" });
  });
});

describe("POST /api/agui/run — injected full-assistant runner", () => {
  const historyInput = {
    threadId: "thread_r",
    runId: "run_r",
    messages: [
      { id: "m1", role: "system", content: "You are LinchKit." },
      { id: "m2", role: "user", content: "List my orders" },
      {
        id: "m3",
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [
          {
            id: "tc_1",
            type: "function",
            function: { name: "queryRecords", arguments: '{"entity":"order"}' },
          },
        ],
      },
      { id: "m4", role: "tool", toolCallId: "tc_1", content: '[{"id":"o1"}]' },
      { id: "m5", role: "user", content: "And the first one?" },
    ],
    tools: [],
    context: [{ description: "entity", value: "order" }],
  };

  test("runner replaces the AIService bridge and its events are RUN_* framed", async () => {
    const seen: { messages: number; context: string | undefined }[] = [];
    const app = await createAgUiApp({
      aiService: fakeCompleteService(),
      runner: async ({ input, emit }) => {
        seen.push({ messages: input.messages.length, context: input.context[0]?.description });
        const messageId = "rm_1";
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "Order o1" });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        emit({ type: EventType.TOOL_CALL_START, toolCallId: "tc_2", toolCallName: "getRecord" });
        emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc_2", delta: '{"id":"o1"}' });
        emit({ type: EventType.TOOL_CALL_END, toolCallId: "tc_2" });
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "rm_2",
          toolCallId: "tc_2",
          content: '{"id":"o1"}',
          role: "tool",
        });
      },
    });

    const res = await postRun(app, historyInput);
    expect(res.status).toBe(200);

    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);

    // The runner received the FULL validated history (all 5 messages,
    // including assistant tool calls and the tool result) plus context.
    expect(seen).toEqual([{ messages: 5, context: "entity" }]);
  });

  test("a throwing runner surfaces as RUN_ERROR (no RUN_FINISHED)", async () => {
    const app = await createAgUiApp({
      aiService: fakeCompleteService(),
      runner: async ({ emit, input }) => {
        emit({ type: EventType.TEXT_MESSAGE_START, messageId: "rm", role: "assistant" });
        throw new Error(`assistant exploded for ${input.runId}`);
      },
    });

    const res = await postRun(app, historyInput);
    const events = parseSseEvents(await res.text());
    expect(eventTypes(events)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START", "RUN_ERROR"]);
    expect(events.at(-1)).toMatchObject({ message: "assistant exploded for run_r" });
  });

  test("availability gate still reads aiService.configured when a runner is set", async () => {
    let runnerCalls = 0;
    const app = await createAgUiApp({
      runner: async () => {
        runnerCalls += 1;
      },
    });

    const res = await postRun(app, historyInput);
    expect(res.status).toBe(503);
    expect(runnerCalls).toBe(0);
  });
});

describe("custom base path", () => {
  test("mounts the run route under the provided basePath", async () => {
    const app = await createAgUiApp({ aiService: fakeCompleteService(), basePath: "/agui-v2" });
    const res = await app.handle(
      new Request("http://local.test/agui-v2/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "t", runId: "r", messages: [], tools: [], context: [] }),
      }),
    );

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  test("an already-aborted request yields an empty stream and never calls the AI service", async () => {
    let aiCalls = 0;
    const base = fakeCompleteService();
    const counted: AIService = {
      ...base,
      complete: async (...args) => {
        aiCalls += 1;
        return base.complete(...args);
      },
    };
    const app = await createAgUiApp({ aiService: counted });

    const controller = new AbortController();
    controller.abort();
    const res = await app.handle(
      new Request(RUN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validInput),
        signal: controller.signal,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(aiCalls).toBe(0);
  });
});

describe("makeRunFinishedEvent (Spec 71 P1 — outcome-capable finish frame)", () => {
  test("a no-outcome finish is byte-identical to the legacy frame", () => {
    const event = makeRunFinishedEvent({ threadId: "thread_1", runId: "run_1" });

    // The legacy frame was a plain object literal with no `outcome` key.
    expect(event).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: "thread_1",
      runId: "run_1",
    });
    expect("outcome" in event).toBe(false);
    // Encoding stays identical to the pre-HITL wire form.
    expect(JSON.stringify(event)).toBe(
      JSON.stringify({ type: "RUN_FINISHED", threadId: "thread_1", runId: "run_1" }),
    );
  });

  test("attaches an interrupt outcome and the frame round-trips through the schema", () => {
    const interrupt = {
      id: "int_1",
      reason: "action.approval.required",
      toolCallId: "lk:propose-mutation:abc",
      metadata: { action: "create_product", proposedInput: { name: "Widget", price: 9.9 } },
    };
    const event = makeRunFinishedEvent({
      threadId: "thread_1",
      runId: "run_a",
      outcome: makeInterruptOutcome([interrupt]),
    });

    const parsed = RunFinishedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome?.type === "interrupt") {
      expect(parsed.data.outcome.interrupts[0]?.id).toBe("int_1");
    }
  });

  test("a success outcome parses on the success branch", () => {
    const event = makeRunFinishedEvent({
      threadId: "thread_1",
      runId: "run_b",
      outcome: { type: "success" },
    });

    const parsed = RunFinishedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome?.type).toBe("success");
    }
  });
});
