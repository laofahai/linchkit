/**
 * AG-UI assistant runner — runs the SAME assistant brain as `/api/ai/chat`
 * (ontology-aware system prompt, server-side read-only tools, multi-step
 * agent loop via Vercel AI SDK `streamText`) and emits official AG-UI
 * protocol events instead of the Vercel UI message stream.
 *
 * Injected into cap-adapter-ag-ui's run endpoint (see routes/agui-api.ts)
 * so the admin UI assistant keeps its full capabilities when it talks the
 * AG-UI protocol: switching the transport must not lose features (#89).
 *
 * Zod-version note: `@ag-ui/core` ships zod-3 schemas. This module only uses
 * its exported TYPES + the `EventType` enum — never composes its schemas
 * with the repo's zod-4 (established pattern from #546).
 */

import type {
  AGUIEvent,
  AgUiAgentRunner,
  Message as AgUiMessage,
  RunAgentInput,
} from "@linchkit/cap-adapter-ag-ui";
import { EventType } from "@linchkit/cap-adapter-ag-ui";
import type { jsonSchema, ModelMessage, TextStreamPart, ToolSet } from "ai";
import type { ServerOptions } from "../server";

// ── Context extraction ──────────────────────────────────────

/**
 * Well-known AG-UI context entry descriptions the LinchKit transport sends
 * (see cap-adapter-ui's agui-chat-transport.ts). AG-UI context is a flat
 * `{ description, value }[]`; these keys mirror `/api/ai/chat`'s
 * `body.context.{entity,recordId,locale}`.
 */
export const AG_UI_CONTEXT_KEYS = {
  entity: "entity",
  recordId: "recordId",
  locale: "locale",
} as const;

/** Read a well-known context entry from a RunAgentInput. */
export function agUiContextValue(
  input: Partial<Pick<RunAgentInput, "context">>,
  description: string,
): string | undefined {
  // `context` is required by the validated protocol type, but tolerate its
  // absence — the runner may receive inputs from less strict callers.
  const entry = input.context?.find((c) => c.description === description);
  return entry?.value || undefined;
}

// ── AG-UI messages → ModelMessage[] ─────────────────────────

/** Extract plain text from an AG-UI user message content (string | parts). */
function userText(message: AgUiMessage & { role: "user" }): string {
  const value = message.content;
  // Tolerate undefined/null content from loosely-validated third-party input.
  if (!value) return "";
  if (typeof value === "string") return value;
  return value
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Parse a JSON tool-call arguments string, tolerating partial/invalid JSON. */
function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Map the AG-UI conversation history onto Vercel AI SDK `ModelMessage[]`,
 * preserving assistant tool calls and tool results so multi-turn
 * conversations keep their full tool context (mirrors what
 * `convertToModelMessages` produces for `/api/ai/chat`).
 */
export function toModelMessagesFromAgUi(messages: AgUiMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  // toolCallId → toolName lookup for tool-result messages.
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.function.name);
      }
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user": {
        const text = userText(message);
        if (text.length > 0) out.push({ role: "user", content: text });
        break;
      }
      case "assistant": {
        const content: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> =
          [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseArgs(call.function.arguments),
          });
        }
        if (content.length > 0) {
          out.push({ role: "assistant", content });
        }
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: toolNames.get(message.toolCallId) ?? "unknown",
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
      case "activity":
      case "reasoning":
        // No ModelMessage counterpart — skipped (same as the run endpoint's
        // default bridge).
        break;
    }
  }

  return out;
}

// ── AG-UI frontend tools → AI SDK tools ─────────────────────

/**
 * Translate the AG-UI client-declared frontend tools (`input.tools` —
 * name/description/JSON-schema parameters) into Vercel AI SDK tools WITHOUT
 * an `execute` function: the model may call them, the resulting `tool-call`
 * stream part is forwarded to the client as TOOL_CALL_* events (see
 * {@link streamPartToAgUiEvents}), and execution happens client-side per the
 * AG-UI model — never on the server.
 *
 * Termination: a step that ends in unexecuted client tool calls produces no
 * tool results, so `streamText` does not start a follow-up step regardless
 * of `stopWhen` — the stream completes and the run endpoint emits
 * RUN_FINISHED (no hang).
 *
 * Collision policy: server tools win. An input tool whose name matches a
 * server-side tool is skipped and reported in `skipped`.
 *
 * `toSchema` is the `jsonSchema()` helper from the `ai` package, passed in
 * by the caller because this module lazy-imports `ai` (and so this helper
 * stays synchronous and pure for tests).
 */
export function buildFrontendToolSet(options: {
  tools: RunAgentInput["tools"];
  serverToolNames: ReadonlySet<string>;
  toSchema: typeof jsonSchema;
}): { tools: ToolSet; skipped: string[] } {
  const out: ToolSet = {};
  const skipped: string[] = [];

  for (const tool of options.tools ?? []) {
    if (options.serverToolNames.has(tool.name)) {
      skipped.push(tool.name);
      continue;
    }
    // Upstream `Tool.parameters` is free-form (`z.any()`); only a plain
    // object is a usable JSON Schema — anything else degrades to "accept
    // any input" (mirrors the default bridge's toAiTools fallback).
    const parameters: unknown = tool.parameters;
    const schema =
      typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)
        ? (parameters as Parameters<typeof jsonSchema>[0])
        : {};
    out[tool.name] = {
      // Runtime-declared tool — input/output types unknown at compile time.
      type: "dynamic",
      description: tool.description,
      inputSchema: options.toSchema(schema),
      // No `execute`: frontend tools are executed by the AG-UI client.
    };
  }

  return { tools: out, skipped };
}

// ── streamText fullStream → AG-UI events ────────────────────

/**
 * Translate one Vercel AI SDK `fullStream` part into AG-UI protocol events.
 *
 * Tool calls are emitted as one consolidated START → ARGS → END triple per
 * `tool-call` part (deterministic ordering regardless of whether the
 * provider streamed `tool-input-delta`s), and each server-side execution
 * result becomes a TOOL_CALL_RESULT. A model/provider `error` part throws —
 * the run endpoint maps it to RUN_ERROR.
 */
export function streamPartToAgUiEvents(part: TextStreamPart<ToolSet>): AGUIEvent[] {
  switch (part.type) {
    case "text-start":
      return [{ type: EventType.TEXT_MESSAGE_START, messageId: part.id, role: "assistant" }];
    case "text-delta":
      // Protocol: TEXT_MESSAGE_CONTENT.delta must be non-empty.
      return part.text.length > 0
        ? [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: part.id, delta: part.text }]
        : [];
    case "text-end":
      return [{ type: EventType.TEXT_MESSAGE_END, messageId: part.id }];
    case "tool-call":
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: part.toolCallId,
          toolCallName: part.toolName,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: part.toolCallId,
          delta: JSON.stringify(part.input ?? {}),
        },
        { type: EventType.TOOL_CALL_END, toolCallId: part.toolCallId },
      ];
    case "tool-result":
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: crypto.randomUUID(),
          toolCallId: part.toolCallId,
          content: JSON.stringify(part.output ?? null),
          role: "tool",
        },
      ];
    case "tool-error":
      // Surface tool failures as a structured result so the model's
      // follow-up text (which has already seen the error) stays coherent.
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: crypto.randomUUID(),
          toolCallId: part.toolCallId,
          content: JSON.stringify({
            error: part.error instanceof Error ? part.error.message : String(part.error),
          }),
          role: "tool",
        },
      ];
    case "error":
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    default:
      // start/finish/step/reasoning/source/file/raw/abort/tool-input-* —
      // no AG-UI counterpart needed (tool-input-* is superseded by the
      // consolidated `tool-call` triple above).
      return [];
  }
}

// ── Runner factory ──────────────────────────────────────────

/**
 * Build the AG-UI agent runner from ServerOptions.
 *
 * Mirrors the `/api/ai/chat` handler in routes/ai-api.ts: same model
 * resolution, actor + tenant scoping, system prompt, read-only tools and
 * multi-step loop — only the output framing differs (AG-UI events).
 */
export function createAssistantAgUiRunner(options: ServerOptions): AgUiAgentRunner {
  return async ({ input, emit, signal, request }) => {
    const aiConfig = options.aiConfig;
    if (!aiConfig) {
      // routes/agui-api.ts only injects this runner when aiConfig exists.
      throw new Error("AI service is not configured.");
    }

    // Lazy imports — mirrors ai-api.ts so heavy deps load on first use only.
    const { streamText, stepCountIs, jsonSchema } = await import("ai");
    const { resolveLanguageModel } = await import("@linchkit/cap-ai-provider");
    const { createTenantAwareDataProvider } = await import("@linchkit/core/server");
    const { buildSystemPrompt, extractLocale } = await import("./system-prompt");
    const { buildTools } = await import("./tools");
    const { ANONYMOUS_ACTOR } = await import("../routes/shared");

    const assistantConfig = aiConfig.assistant;
    const model = await resolveLanguageModel(aiConfig, assistantConfig?.model ?? "fast");

    // Resolve actor for permission-aware tool calls.
    const actor =
      (request && options.resolveRequestActor
        ? await options.resolveRequestActor(request)
        : undefined) ?? ANONYMOUS_ACTOR;

    // Tenant-scoped data provider (same scoping as the chat endpoint).
    const tenantId =
      request && options.resolveRequestTenantId
        ? await options.resolveRequestTenantId(request, actor)
        : undefined;
    const dataProvider = options.dataProvider;
    const scopedProvider =
      tenantId && dataProvider
        ? createTenantAwareDataProvider(dataProvider, tenantId)
        : dataProvider;

    // Page context travels as AG-UI context entries (entity/recordId/locale).
    const entity = agUiContextValue(input, AG_UI_CONTEXT_KEYS.entity);
    const recordId = agUiContextValue(input, AG_UI_CONTEXT_KEYS.recordId);
    const locale = extractLocale(agUiContextValue(input, AG_UI_CONTEXT_KEYS.locale), request);

    // Chat is read-only — writes go through the propose-and-confirm flow
    // (intent resolver + ActionProposalCard). See issue #285 / #238.
    const systemPrompt = buildSystemPrompt({
      assistantConfig,
      ontologyRegistry: options.ontologyRegistry,
      entityRegistry: options.entityRegistry,
      context: { entity, recordId, locale },
      allowActionExecution: false,
    });

    const tools = buildTools({
      dataProvider: scopedProvider,
      commandLayer: options.commandLayer,
      entityRegistry: options.entityRegistry,
      ontologyRegistry: options.ontologyRegistry,
      actor,
      allowActionExecution: false,
    });

    // Client-declared frontend tools (AG-UI `input.tools`) are exposed to
    // the model without an execute fn — their calls stream back to the
    // client as TOOL_CALL_* events. Server tools win on name collision
    // (colliding input tools are skipped inside buildFrontendToolSet).
    const { tools: frontendTools } = buildFrontendToolSet({
      tools: input.tools,
      serverToolNames: new Set(Object.keys(tools)),
      toSchema: jsonSchema,
    });

    const result = streamText({
      model,
      system: systemPrompt,
      messages: toModelMessagesFromAgUi(input.messages),
      tools: { ...frontendTools, ...tools },
      stopWhen: stepCountIs(assistantConfig?.maxSteps ?? 5),
      temperature: assistantConfig?.temperature ?? 0.3,
      abortSignal: signal,
    });

    for await (const part of result.fullStream) {
      if (signal?.aborted) break; // client went away — stop consuming
      for (const event of streamPartToAgUiEvents(part)) {
        emit(event);
      }
    }
  };
}
