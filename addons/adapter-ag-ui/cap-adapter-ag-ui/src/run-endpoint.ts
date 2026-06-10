/**
 * AG-UI run endpoint — POST `<basePath>/run` (default `/api/agui/run`).
 *
 * Bridges the AG-UI protocol (https://docs.ag-ui.com) onto LinchKit's
 * existing AI assistant seam: the same `AIService` instance that
 * cap-adapter-server's `/api/ai/*` routes use (`ctx.aiService` /
 * `options.aiService`). No provider logic is duplicated here.
 *
 * Flow per run:
 *   1. Validate the body against the official `RunAgentInputSchema` from
 *      `@ag-ui/core` (400 on failure). Per the upstream contract, `messages`,
 *      `tools` and `context` are required arrays.
 *   2. Return the same 503 contract as ai-api.ts when the AI service is
 *      not configured.
 *   3. Stream SSE frames (`data: <json>\n\n`):
 *      RUN_STARTED → TEXT_MESSAGE_* (assistant text) → TOOL_CALL_* (one
 *      triple per requested frontend tool call) → RUN_FINISHED, or
 *      RUN_ERROR if the bridge fails mid-run.
 *
 * Tool calls are only *emitted* — per the AG-UI model the frontend executes
 * its own tools. Server-side tool execution stays inside the assistant
 * seam (CommandLayer-guarded) and is not re-implemented here.
 */

import type { AIMessage, AIService, AITool } from "@linchkit/core";
import type { Elysia } from "elysia";
import {
  type AGUIEvent,
  EventType,
  encodeSseEvent,
  type RunAgentInput,
  RunAgentInputSchema,
  type TextInputContent,
} from "./protocol";

/** Injected dependencies for the AG-UI run endpoint (test seam). */
export interface AgUiRunDeps {
  /** Same seam as cap-adapter-server's ai-api.ts (`options.aiService`). */
  aiService?: AIService;
  /** Base path the run endpoint is mounted under. @default "/api/agui" */
  basePath?: string;
}

/** Default base path for the AG-UI HTTP endpoints. */
export const DEFAULT_AG_UI_BASE_PATH = "/api/agui";

// Same 503 contract as ai-api.ts's chat endpoint.
const AI_NOT_CONFIGURED_MESSAGE =
  "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable the assistant.";

/** Map AG-UI conversation messages onto the core `AIMessage` shape. */
export function toAiMessages(input: RunAgentInput): AIMessage[] {
  const messages: AIMessage[] = [];

  // Fold client-provided context entries into a leading system message.
  if (input.context.length > 0) {
    const contextText = input.context.map((c) => `${c.description}: ${c.value}`).join("\n");
    messages.push({ role: "system", content: `Context provided by the client:\n${contextText}` });
  }

  for (const message of input.messages) {
    switch (message.role) {
      case "developer":
      case "system":
        messages.push({ role: "system", content: message.content });
        break;
      case "user": {
        // Upstream user content is `string | InputContent[]` (multimodal).
        // Phase 1 keeps the text parts and drops binary/media parts.
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part): part is TextInputContent => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (typeof message.content === "string" || content.length > 0) {
          messages.push({ role: "user", content });
        }
        break;
      }
      case "assistant":
        // Tool-call-only assistant messages carry no text — skip them
        // (core AIMessage has no tool-call slot yet).
        if (message.content) messages.push({ role: "assistant", content: message.content });
        break;
      case "tool":
        // Core AIMessage has no "tool" role — phase 1 skips tool results.
        break;
      case "activity":
      case "reasoning":
        // Structured activity payloads / model reasoning traces have no
        // counterpart in the core AIMessage shape — phase 1 skips them.
        break;
    }
  }

  return messages;
}

/** Map AG-UI frontend tool definitions onto the core `AITool` shape. */
export function toAiTools(tools: RunAgentInput["tools"]): AITool[] {
  return tools.map((tool) => {
    // Upstream `Tool.parameters` is an optional free-form JSON Schema
    // (`z.any()`); core AITool requires a JSON Schema object.
    const parameters: unknown = tool.parameters;
    return {
      name: tool.name,
      description: tool.description,
      parameters:
        typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)
          ? (parameters as Record<string, unknown>)
          : {},
    };
  });
}

/**
 * Run the agent through the assistant seam and stream AG-UI events.
 *
 * Uses `aiService.completeStream` (token-level deltas) when available and no
 * frontend tools were requested; otherwise falls back to `aiService.complete`
 * and re-frames the result (text + tool calls) as protocol events.
 */
function createRunEventStream(
  aiService: AIService,
  input: RunAgentInput,
  signal?: AbortSignal,
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      // The consumer may cancel the stream (client disconnect) at any point —
      // enqueue() then throws. Track closure so a disconnect stops the run
      // instead of crashing the server or leaking AI work.
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed/cancelled by the consumer
        }
      };
      const aborted = (): boolean => closed || signal?.aborted === true;
      const emit = (event: AGUIEvent): void => {
        if (aborted()) return;
        try {
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
        } catch {
          closed = true;
        }
      };

      if (aborted()) {
        close();
        return;
      }

      emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });

      try {
        const messages = toAiMessages(input);
        const tools = toAiTools(input.tools);

        if (tools.length === 0 && aiService.completeStream) {
          // Token-level streaming path (no frontend tools requested).
          const messageId = crypto.randomUUID();
          const result = await aiService.completeStream({ messages });
          emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
          for await (const delta of result.textStream) {
            if (aborted()) break; // client went away — stop consuming the model
            if (delta.length === 0) continue; // protocol: delta must be non-empty
            emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
          }
          emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        } else {
          // Completion path — supports tool calls.
          const result = await aiService.complete({
            messages,
            ...(tools.length > 0 ? { tools } : {}),
          });

          let parentMessageId: string | undefined;
          if (result.content) {
            const messageId = crypto.randomUUID();
            parentMessageId = messageId;
            emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
            emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: result.content });
            emit({ type: EventType.TEXT_MESSAGE_END, messageId });
          }

          for (const call of result.toolCalls ?? []) {
            const toolCallId = crypto.randomUUID();
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: call.toolName,
              ...(parentMessageId ? { parentMessageId } : {}),
            });
            emit({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: JSON.stringify(call.args ?? {}),
            });
            emit({ type: EventType.TOOL_CALL_END, toolCallId });
          }
        }

        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      } catch (err) {
        emit({
          type: EventType.RUN_ERROR,
          message: err instanceof Error ? err.message : "AG-UI run failed",
        });
      } finally {
        close();
      }
    },
  });
}

/**
 * Mount the AG-UI run route on an existing Elysia app.
 *
 * Reads the request body from the destructured context `body` (never
 * `request.json()` — the stream is already consumed by Elysia).
 */
export function mountAgUiRunRoute(app: Elysia, deps: AgUiRunDeps): Elysia {
  const basePath = deps.basePath ?? DEFAULT_AG_UI_BASE_PATH;
  const aiService = deps.aiService;

  app.post(`${basePath}/run`, ({ body, set, request }) => {
    // Validate input first (mirrors ai-api.ts ordering), then availability.
    // RunAgentInputSchema is the official zod-3 schema from @ag-ui/core —
    // used as-is (its own .safeParse), never composed with local zod-4.
    const parsed = RunAgentInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      set.status = 400;
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "input";
      set.headers["content-type"] = "application/json";
      return {
        success: false,
        error: { message: `Invalid RunAgentInput: ${where}: ${issue?.message ?? "invalid"}` },
      };
    }

    if (!aiService?.configured) {
      set.status = 503;
      return { success: false, error: { message: AI_NOT_CONFIGURED_MESSAGE } };
    }

    // request.signal propagates client disconnects into the event stream.
    return new Response(createRunEventStream(aiService, parsed.data, request.signal), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  return app;
}

/** Build a standalone Elysia app serving only the AG-UI endpoints. */
export async function createAgUiApp(deps: AgUiRunDeps): Promise<Elysia> {
  // Lazy import keeps elysia out of the capability-registration path.
  const { Elysia: ElysiaCtor } = await import("elysia");
  return mountAgUiRunRoute(new ElysiaCtor(), deps);
}
