import { describe, expect, test } from "bun:test";
import {
  EventType,
  encodeSseEvent,
  type Interrupt,
  InterruptSchema,
  makeInterruptOutcome,
  ResumeEntrySchema,
  RunAgentInputSchema,
  RunFinishedEventSchema,
  RunFinishedOutcomeSchema,
  SUCCESS_OUTCOME,
} from "../src/protocol";

/** A representative approval interrupt (Spec 71 §4.2). */
function sampleInterrupt(): Interrupt {
  return {
    id: "int_1",
    reason: "action.approval.required",
    message: 'Create product "Widget" (price 9.9)?',
    toolCallId: "lk:propose-mutation:abc",
    responseSchema: { type: "object", properties: { price: { type: "number" } } },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    metadata: {
      action: "create_product",
      proposedInput: { name: "Widget", price: 9.9 },
      inputDigest: "digest_xyz",
    },
  };
}

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

// ── Human-in-the-loop protocol surface (Spec 71 P1) ─────────

describe("makeInterruptOutcome (Spec 71 §3.4 / §4.2)", () => {
  test("returns the discriminated interrupt shape with the interrupts preserved", () => {
    const interrupt = sampleInterrupt();
    const outcome = makeInterruptOutcome([interrupt]);

    expect(outcome.type).toBe("interrupt");
    expect(outcome.interrupts).toHaveLength(1);
    expect(outcome.interrupts[0]).toEqual(interrupt);
  });

  test("validates against the upstream RunFinishedOutcomeSchema (interrupt branch)", () => {
    const parsed = RunFinishedOutcomeSchema.safeParse(makeInterruptOutcome([sampleInterrupt()]));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("interrupt");
    }
  });

  test("throws on an empty interrupts list (the upstream schema requires .min(1))", () => {
    expect(() => makeInterruptOutcome([])).toThrow(/at least one interrupt/);
    // Prove the guard prevents a schema-invalid frame: an empty list WOULD fail
    // the upstream schema, so the throw is what keeps the encoder safe.
    expect(RunFinishedOutcomeSchema.safeParse({ type: "interrupt", interrupts: [] }).success).toBe(
      false,
    );
  });

  test("SUCCESS_OUTCOME validates against the success branch", () => {
    const parsed = RunFinishedOutcomeSchema.safeParse(SUCCESS_OUTCOME);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("success");
    }
  });
});

describe("RunFinishedEvent with outcome (Spec 71 §3.1)", () => {
  test("an interrupt outcome round-trips through RunFinishedEventSchema.safeParse", () => {
    const interrupt = sampleInterrupt();
    const event = {
      type: EventType.RUN_FINISHED,
      threadId: "thread_1",
      runId: "run_a",
      outcome: makeInterruptOutcome([interrupt]),
    };

    const parsed = RunFinishedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // `outcome` is z.optional(z.nullable(...)) upstream — narrow it.
      expect(parsed.data.outcome?.type).toBe("interrupt");
      if (parsed.data.outcome?.type === "interrupt") {
        expect(parsed.data.outcome.interrupts).toHaveLength(1);
        expect(parsed.data.outcome.interrupts[0]?.id).toBe("int_1");
        expect(parsed.data.outcome.interrupts[0]?.reason).toBe("action.approval.required");
        expect(parsed.data.outcome.interrupts[0]?.metadata?.action).toBe("create_product");
      }
    }
  });

  test("a plain finish (no outcome) still parses and is unchanged", () => {
    const event = { type: EventType.RUN_FINISHED, threadId: "thread_1", runId: "run_a" };

    const parsed = RunFinishedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.threadId).toBe("thread_1");
      expect(parsed.data.runId).toBe("run_a");
      // No outcome on a plain finish — backward-compatible with the legacy frame.
      expect(parsed.data.outcome).toBeUndefined();
    }
  });

  test("a finish carrying the success outcome parses on the success branch", () => {
    const parsed = RunFinishedEventSchema.safeParse({
      type: EventType.RUN_FINISHED,
      threadId: "thread_1",
      runId: "run_b",
      outcome: SUCCESS_OUTCOME,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome?.type).toBe("success");
    }
  });
});

describe("ResumeEntrySchema (Spec 71 §3.3 / §4.2)", () => {
  test("accepts an approve (resolved) payload with edited input + baseDigest", () => {
    const parsed = ResumeEntrySchema.safeParse({
      interruptId: "int_1",
      status: "resolved",
      payload: {
        action: "create_product",
        input: { name: "Widget", price: 8.9 },
        baseDigest: "digest_xyz",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.interruptId).toBe("int_1");
      expect(parsed.data.status).toBe("resolved");
    }
  });

  test("accepts a reject (cancelled) entry with no payload", () => {
    const parsed = ResumeEntrySchema.safeParse({ interruptId: "int_1", status: "cancelled" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("cancelled");
      expect(parsed.data.payload).toBeUndefined();
    }
  });

  test("rejects an unknown status (not resolved/cancelled)", () => {
    const parsed = ResumeEntrySchema.safeParse({ interruptId: "int_1", status: "approved" });
    expect(parsed.success).toBe(false);
  });

  test("rejects a resume missing interruptId", () => {
    const parsed = ResumeEntrySchema.safeParse({ status: "resolved" });
    expect(parsed.success).toBe(false);
  });
});

describe("InterruptSchema (Spec 71 §3.2)", () => {
  test("accepts the full interrupt shape we emit", () => {
    const parsed = InterruptSchema.safeParse(sampleInterrupt());
    expect(parsed.success).toBe(true);
  });

  test("accepts a minimal interrupt (id + reason only)", () => {
    const parsed = InterruptSchema.safeParse({ id: "int_2", reason: "action.approval.required" });
    expect(parsed.success).toBe(true);
  });

  test("rejects an interrupt missing the required reason", () => {
    const parsed = InterruptSchema.safeParse({ id: "int_3" });
    expect(parsed.success).toBe(false);
  });
});
