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
  type AgUiInterruptDescriptor,
  ASSISTANT_HITL_CAPABILITIES,
  EventType,
  encodeSseEvent,
  type HumanInTheLoopCapabilities,
  HumanInTheLoopCapabilitiesSchema,
  makeInterruptOutcome,
  type RunAgentInput,
  RunAgentInputSchema,
  type RunFinishedEvent,
  type RunFinishedOutcome,
  type TextInputContent,
} from "./protocol";

/** Emit callback handed to a custom agent runner. Drops events after disconnect. */
export type AgUiEmit = (event: AGUIEvent) => void;

/**
 * Build a `RUN_FINISHED` protocol frame, optionally carrying a run `outcome`
 * (Spec 71 §3.1 / §4.2).
 *
 * The AG-UI HITL protocol delivers an approval interrupt as an optional
 * `outcome` on `RUN_FINISHED` (there is no dedicated INTERRUPT event). This
 * helper is the single place that constructs the finish frame so the addon
 * never hand-writes the optional/nullable `outcome` shape.
 *
 * Backward-compatible by construction: when `outcome` is omitted the frame is
 * byte-identical to the pre-HITL `{ type, threadId, runId }` finish — the
 * `outcome` key is only added when an outcome is actually supplied. Upstream
 * types `outcome` as `z.optional(z.nullable(...))`, so an absent outcome and a
 * plain finish encode identically.
 */
export function makeRunFinishedEvent(options: {
  threadId: string;
  runId: string;
  outcome?: RunFinishedOutcome;
}): RunFinishedEvent {
  const { threadId, runId, outcome } = options;
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    // Only attach `outcome` when present so a no-outcome finish stays
    // byte-identical to the legacy frame (no `outcome: undefined` key).
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Custom agent runner seam.
 *
 * A host server (e.g. cap-adapter-server) injects a runner that executes the
 * FULL assistant semantics — ontology-aware system prompt, server-side tools,
 * multi-step agent loop — and emits AG-UI protocol events as it goes. The
 * endpoint still owns input validation, the RUN_STARTED / RUN_FINISHED frame,
 * and RUN_ERROR mapping: a runner only emits the events *between* those.
 * Throwing aborts the run and surfaces as RUN_ERROR.
 *
 * Return value (Spec 71 §4.3, P2a): a runner returns `void` for a plain
 * success finish, OR an {@link AgUiInterruptDescriptor} when the model proposed
 * a mutation that needs human approval — the endpoint then attaches an
 * interrupt outcome to `RUN_FINISHED` instead of a plain finish. This is the
 * documented public-type change from the P1 `=> Promise<void>` signature; all
 * downstream runner implementations are migrated together.
 */
export type AgUiAgentRunner = (options: {
  /** Validated RunAgentInput (full message history, tools, context). */
  input: RunAgentInput;
  /** Emit one protocol event (TEXT_MESSAGE_*, TOOL_CALL_*, ...). */
  emit: AgUiEmit;
  /** Aborts when the client disconnects — stop consuming the model. */
  signal?: AbortSignal;
  /** Raw HTTP request — for actor / tenant / locale resolution. */
  request?: Request;
  // `void` (not `undefined`) is intentional and required (Spec 71 §4.3): a
  // read-only runner is an `async () => {}` whose inferred return is
  // `Promise<void>`, which is assignable to `Promise<void | X>` but NOT to
  // `Promise<undefined | X>`. Narrowing to `undefined` would break every
  // existing void-returning runner.
  // biome-ignore lint/suspicious/noConfusingVoidType: void is the legacy return; the union widens it to optionally carry an interrupt descriptor.
}) => Promise<void | AgUiInterruptDescriptor>;

/** Injected dependencies for the AG-UI run endpoint (test seam). */
export interface AgUiRunDeps {
  /** Same seam as cap-adapter-server's ai-api.ts (`options.aiService`). */
  aiService?: AIService;
  /** Base path the run endpoint is mounted under. @default "/api/agui" */
  basePath?: string;
  /**
   * Optional full-assistant runner. When provided it replaces the default
   * AIService bridge for event production (the availability gate still reads
   * `aiService.configured` so the 503 contract matches `/api/ai/chat`).
   */
  runner?: AgUiAgentRunner;
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
function createRunEventStream(options: {
  aiService: AIService;
  input: RunAgentInput;
  signal?: AbortSignal;
  runner?: AgUiAgentRunner;
  request?: Request;
}): ReadableStream {
  const { aiService, input, signal, runner, request } = options;
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
        if (runner) {
          // Host-injected full-assistant runner (system prompt + server-side
          // tools + multi-step). The endpoint keeps the RUN_* frame.
          const descriptor = await runner({ input, emit, signal, request });
          // Spec 71 §4.3 / P2a: when the runner proposed a mutation it returns
          // an interrupt descriptor; the endpoint (which owns the RUN_FINISHED
          // frame) attaches the interrupt outcome. When it returns void, the
          // finish stays byte-identical to the legacy plain frame.
          // `makeInterruptOutcome` throws on empty, but `AgUiInterruptDescriptor`
          // always carries ≥1 interrupt by construction (the runner builds it
          // via the same helper); the guard is the single source of truth.
          const outcome =
            descriptor && descriptor.interrupts.length > 0
              ? makeInterruptOutcome(descriptor.interrupts)
              : undefined;
          emit(
            makeRunFinishedEvent({
              threadId: input.threadId,
              runId: input.runId,
              ...(outcome ? { outcome } : {}),
            }),
          );
          return;
        }

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

        emit(makeRunFinishedEvent({ threadId: input.threadId, runId: input.runId }));
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
 * Structural slice of the Elysia handler context the run handler needs.
 * Declared structurally so a host server can forward its own Elysia context
 * without this package appearing in its compile-time route types.
 */
export interface AgUiRunHandlerContext {
  /** Parsed request body (Elysia context `body` — never `request.json()`). */
  body: unknown;
  /** Elysia response mutator (`set.status`, `set.headers`). */
  set: { status?: number | string; headers: Record<string, unknown> };
  /** Raw request — `request.signal` propagates client disconnects. */
  request: Request;
}

/** The AG-UI run route handler produced by {@link createAgUiRunHandler}. */
export type AgUiRunHandler = (
  ctx: AgUiRunHandlerContext,
) => Response | { success: false; error: { message: string } };

/**
 * Build the AG-UI run handler (validation → availability → SSE stream).
 *
 * Exported separately from {@link mountAgUiRunRoute} so host servers (e.g.
 * cap-adapter-server) can mount the route on their own app under their own
 * path while reusing the exact endpoint contract.
 */
export function createAgUiRunHandler(deps: AgUiRunDeps): AgUiRunHandler {
  const aiService = deps.aiService;

  return ({ body, set, request }) => {
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
    return new Response(
      createRunEventStream({
        aiService,
        input: parsed.data,
        signal: request.signal,
        runner: deps.runner,
        request,
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  };
}

/**
 * Mount the AG-UI run route on an existing Elysia app.
 *
 * Reads the request body from the destructured context `body` (never
 * `request.json()` — the stream is already consumed by Elysia).
 */
export function mountAgUiRunRoute(app: Elysia, deps: AgUiRunDeps): Elysia {
  const basePath = deps.basePath ?? DEFAULT_AG_UI_BASE_PATH;
  const handler = createAgUiRunHandler(deps);

  app.post(`${basePath}/run`, ({ body, set, request }) => handler({ body, set, request }));

  return app;
}

// ── HITL capability discovery surface (Spec 71 P5 §3.5) ─────
//
// The minimal transport (§9.2 decision: keep raw `run()`, no stateful
// `AbstractAgent`) has no `getCapabilities()` protocol slot. The smallest
// correct seam is therefore a tiny read-only discovery endpoint that returns
// the agent-advertised `HumanInTheLoopCapabilities` shape, so a conformant
// AG-UI client can discover — WITHOUT a run — that this endpoint participates in
// the interrupt protocol (emits interrupt outcomes, accepts `resume[]`) and
// supports approve-with-edits. The body is the canonical
// {@link ASSISTANT_HITL_CAPABILITIES}, validated once at module init against the
// upstream schema so a value/shape drift fails loudly rather than serving an
// invalid capability descriptor.

/** The capabilities the discovery endpoint advertises (Spec 71 P5 §3.5). */
export interface AgUiCapabilitiesResponse {
  /** Human-in-the-loop support — emits interrupt outcomes, accepts resume[]. */
  humanInTheLoop: HumanInTheLoopCapabilities;
}

/**
 * Build the advertised capabilities body. Validates the canonical HITL shape
 * against the upstream `HumanInTheLoopCapabilitiesSchema` (zod-3, used directly)
 * so an inconsistent constant fails at the source instead of being served.
 */
export function buildAgUiCapabilities(): AgUiCapabilitiesResponse {
  const parsed = HumanInTheLoopCapabilitiesSchema.safeParse(ASSISTANT_HITL_CAPABILITIES);
  if (!parsed.success) {
    throw new Error(
      `ASSISTANT_HITL_CAPABILITIES does not satisfy HumanInTheLoopCapabilitiesSchema: ${parsed.error.message}`,
    );
  }
  // `parsed.data` is the schema-validated shape (strips unknown keys); return it
  // so the wire body can never carry a field the upstream schema rejects.
  return { humanInTheLoop: parsed.data };
}

/**
 * Mount `GET <basePath>/capabilities` — the HITL discovery surface (§3.5).
 * Static JSON, no AI/runner dependency: discovery must answer even when the AI
 * provider is unconfigured (a client still needs to know the protocol shape).
 */
export function mountAgUiCapabilitiesRoute(
  app: Elysia,
  deps?: Pick<AgUiRunDeps, "basePath">,
): Elysia {
  const basePath = deps?.basePath ?? DEFAULT_AG_UI_BASE_PATH;
  const body = buildAgUiCapabilities();
  app.get(`${basePath}/capabilities`, () => body);
  return app;
}

/** Build a standalone Elysia app serving only the AG-UI endpoints. */
export async function createAgUiApp(deps: AgUiRunDeps): Promise<Elysia> {
  // Lazy import keeps elysia out of the capability-registration path.
  const { Elysia: ElysiaCtor } = await import("elysia");
  const app = mountAgUiRunRoute(new ElysiaCtor(), deps);
  return mountAgUiCapabilitiesRoute(app, deps);
}
