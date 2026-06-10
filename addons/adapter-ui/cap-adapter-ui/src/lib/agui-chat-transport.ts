/**
 * AG-UI ChatTransport — drives the Vercel AI SDK `useChat` hook over the
 * official AG-UI protocol (https://docs.ag-ui.com) instead of the SDK's
 * proprietary UI-message stream.
 *
 * Wire path: `useChat` → this transport → `HttpAgent` from `@ag-ui/client`
 * (POST /api/agui/run, SSE) → AG-UI events → translated back into
 * `UIMessageChunk`s the `useChat` state machine consumes. The UI shell,
 * message rendering and tool-part rendering in ai-assistant.tsx stay
 * unchanged — only the socket speaks the open standard (#89).
 *
 * Zod-version note: `@ag-ui/client`/`@ag-ui/core` ship zod-3 schemas. This
 * module uses exported TYPES + the `EventType` enum only — never composes
 * their schemas with the repo's zod-4 (established pattern from #546).
 */

import type {
  Context as AgUiContext,
  Message as AgUiMessage,
  ToolCall as AgUiToolCall,
  BaseEvent,
  RunAgentInput,
  RunErrorEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { EventType, HttpAgent } from "@ag-ui/client";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { getToolName, isToolUIPart } from "ai";

// ── Event source seam ────────────────────────────────────────

/**
 * Structural slice of an rxjs `Observable<BaseEvent>` — lets tests inject a
 * synthetic event source without pulling rxjs into the test graph, and keeps
 * this module decoupled from rxjs types (an internal dep of @ag-ui/client).
 */
export interface AgUiEventSource {
  subscribe(observer: {
    next: (event: BaseEvent) => void;
    error: (err: unknown) => void;
    complete: () => void;
  }): { unsubscribe: () => void };
}

/**
 * Produces the AG-UI event stream for one run. The default implementation
 * wraps `HttpAgent` from `@ag-ui/client`; tests inject a fake.
 */
export type AgUiRunAgentFn = (
  input: RunAgentInput,
  options: { abortSignal?: AbortSignal },
) => AgUiEventSource;

/** Default run function — official `@ag-ui/client` HttpAgent over SSE. */
function createHttpRunAgent(url: string): AgUiRunAgentFn {
  return (input, { abortSignal }) => {
    // One agent per run: `useChat` owns conversation state, so the stateful
    // `runAgent()` orchestration is bypassed in favor of the raw `run()`
    // Observable. `abortRun()` aborts the underlying fetch.
    const agent = new HttpAgent({ url, threadId: input.threadId });
    if (abortSignal) {
      if (abortSignal.aborted) agent.abortRun();
      else abortSignal.addEventListener("abort", () => agent.abortRun(), { once: true });
    }
    return agent.run(input);
  };
}

// ── UIMessage[] → AG-UI messages ─────────────────────────────

/** Join the text parts of a UIMessage into one string. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Serialize a tool output for the AG-UI `tool` message `content` string. */
function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}

/**
 * Map the `useChat` UIMessage history onto AG-UI protocol messages.
 *
 * Faithful per-role mapping: text parts become message content; completed
 * assistant tool invocations become `toolCalls` plus a follow-up `tool`
 * result message, so multi-turn conversations keep their tool context.
 */
export function toAgUiMessages(messages: UIMessage[]): AgUiMessage[] {
  const out: AgUiMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      const text = textOf(message);
      if (text.length > 0) out.push({ id: message.id, role: message.role, content: text });
      continue;
    }

    // assistant — text + tool invocations
    const toolCalls: AgUiToolCall[] = [];
    const toolResults: Extract<AgUiMessage, { role: "tool" }>[] = [];
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      // Only invocations whose input is final belong in the history.
      if (
        part.state !== "input-available" &&
        part.state !== "output-available" &&
        part.state !== "output-error"
      ) {
        continue;
      }
      toolCalls.push({
        id: part.toolCallId,
        type: "function",
        function: { name: getToolName(part), arguments: JSON.stringify(part.input ?? {}) },
      });
      if (part.state === "output-available") {
        toolResults.push({
          id: `${part.toolCallId}_result`,
          role: "tool",
          toolCallId: part.toolCallId,
          content: serializeToolOutput(part.output),
        });
      } else if (part.state === "output-error") {
        toolResults.push({
          id: `${part.toolCallId}_result`,
          role: "tool",
          toolCallId: part.toolCallId,
          content: part.errorText,
          error: part.errorText,
        });
      }
    }

    const text = textOf(message);
    if (text.length > 0 || toolCalls.length > 0) {
      out.push({
        id: message.id,
        role: "assistant",
        ...(text.length > 0 ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }
    out.push(...toolResults);
  }

  return out;
}

// ── AG-UI events → UIMessageChunk ────────────────────────────

/** Parse a string that may contain JSON; fall back to the raw string. */
function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Create a stateful per-run translator: AG-UI protocol event → zero or more
 * `UIMessageChunk`s. Tool-call args stream as deltas and are parsed into the
 * final `tool-input-available` input when TOOL_CALL_END arrives.
 */
export function createAgUiChunkTranslator(): (event: BaseEvent) => UIMessageChunk[] {
  const toolCalls = new Map<string, { toolName: string; argsText: string }>();

  return (event) => {
    switch (event.type) {
      case EventType.RUN_STARTED:
        return [{ type: "start" }];
      case EventType.TEXT_MESSAGE_START: {
        const e = event as TextMessageStartEvent;
        return [{ type: "text-start", id: e.messageId }];
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as TextMessageContentEvent;
        return [{ type: "text-delta", id: e.messageId, delta: e.delta }];
      }
      case EventType.TEXT_MESSAGE_END: {
        const e = event as TextMessageEndEvent;
        return [{ type: "text-end", id: e.messageId }];
      }
      case EventType.TOOL_CALL_START: {
        const e = event as ToolCallStartEvent;
        toolCalls.set(e.toolCallId, { toolName: e.toolCallName, argsText: "" });
        return [{ type: "tool-input-start", toolCallId: e.toolCallId, toolName: e.toolCallName }];
      }
      case EventType.TOOL_CALL_ARGS: {
        const e = event as ToolCallArgsEvent;
        const call = toolCalls.get(e.toolCallId);
        if (!call) return [];
        call.argsText += e.delta;
        return [{ type: "tool-input-delta", toolCallId: e.toolCallId, inputTextDelta: e.delta }];
      }
      case EventType.TOOL_CALL_END: {
        const e = event as ToolCallEndEvent;
        const call = toolCalls.get(e.toolCallId);
        if (!call) return [];
        const parsed = call.argsText.length > 0 ? parseMaybeJson(call.argsText) : {};
        return [
          {
            type: "tool-input-available",
            toolCallId: e.toolCallId,
            toolName: call.toolName,
            input: typeof parsed === "string" ? {} : parsed,
          },
        ];
      }
      case EventType.TOOL_CALL_RESULT: {
        const e = event as ToolCallResultEvent;
        return [
          {
            type: "tool-output-available",
            toolCallId: e.toolCallId,
            output: parseMaybeJson(e.content),
          },
        ];
      }
      case EventType.RUN_FINISHED:
        return [{ type: "finish" }];
      case EventType.RUN_ERROR: {
        const e = event as RunErrorEvent;
        return [{ type: "error", errorText: e.message }];
      }
      default:
        // STEP_*, STATE_*, RAW, CUSTOM, ... — no UIMessageChunk counterpart.
        return [];
    }
  };
}

/** True for errors raised by an intentional abort (user pressed stop). */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message)))
  );
}

/**
 * Pipe an AG-UI event source into a `ReadableStream<UIMessageChunk>` for the
 * `useChat` state machine. Exported for tests.
 */
export function streamUiMessageChunks(source: AgUiEventSource): ReadableStream<UIMessageChunk> {
  const translate = createAgUiChunkTranslator();
  let subscription: { unsubscribe: () => void } | undefined;
  let closed = false;

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed/cancelled by the consumer
        }
      };
      subscription = source.subscribe({
        next: (event) => {
          if (closed) return;
          try {
            for (const chunk of translate(event)) controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        },
        error: (err) => {
          if (!closed && !isAbortError(err)) {
            try {
              controller.enqueue({
                type: "error",
                errorText: err instanceof Error ? err.message : String(err),
              });
            } catch {
              // consumer already cancelled — nothing to surface
            }
          }
          close();
        },
        complete: close,
      });
    },
    cancel() {
      closed = true;
      subscription?.unsubscribe();
    },
  });
}

// ── Transport ────────────────────────────────────────────────

/** Page context sent with each run as AG-UI context entries. */
export interface AgUiPageContext {
  entity?: string;
  recordId?: string;
  locale?: string;
}

export interface AgUiChatTransportOptions {
  /** AG-UI run endpoint. @default "/api/agui/run" */
  api?: string;
  /** Per-request page context provider (entity / recordId / locale). */
  context?: () => AgUiPageContext;
  /** Test seam — replaces the HttpAgent-backed event source. */
  runAgent?: AgUiRunAgentFn;
}

/** Map the page context onto AG-UI `{ description, value }` entries. */
export function toAgUiContext(context: AgUiPageContext | undefined): AgUiContext[] {
  if (!context) return [];
  const entries: AgUiContext[] = [];
  if (context.entity) entries.push({ description: "entity", value: context.entity });
  if (context.recordId) entries.push({ description: "recordId", value: context.recordId });
  if (context.locale) entries.push({ description: "locale", value: context.locale });
  return entries;
}

/**
 * `ChatTransport` implementation speaking the AG-UI protocol via the
 * official `@ag-ui/client` HttpAgent.
 */
export class AgUiChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private readonly runAgentFn: AgUiRunAgentFn;
  private readonly contextFn?: () => AgUiPageContext;

  constructor(options: AgUiChatTransportOptions = {}) {
    this.runAgentFn = options.runAgent ?? createHttpRunAgent(options.api ?? "/api/agui/run");
    this.contextFn = options.context;
  }

  sendMessages: ChatTransport<UI_MESSAGE>["sendMessages"] = async (options) => {
    const input: RunAgentInput = {
      threadId: options.chatId,
      runId: crypto.randomUUID(),
      messages: toAgUiMessages(options.messages),
      // Server-side tools live behind the endpoint (assistant runner);
      // the LinchKit admin assistant registers no frontend tools.
      tools: [],
      context: toAgUiContext(this.contextFn?.()),
      state: {},
      forwardedProps: {},
    };

    const source = this.runAgentFn(input, { abortSignal: options.abortSignal });
    return streamUiMessageChunks(source);
  };

  /** AG-UI runs are not resumable server-side — nothing to reconnect to. */
  reconnectToStream: ChatTransport<UI_MESSAGE>["reconnectToStream"] = async () => null;
}
