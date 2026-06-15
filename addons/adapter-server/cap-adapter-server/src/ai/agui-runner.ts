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
  AgUiInterruptDescriptor,
  Message as AgUiMessage,
  InterruptStore,
  RunAgentInput,
} from "@linchkit/cap-adapter-ag-ui";
import { EventType, InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import type { jsonSchema, LanguageModel, ModelMessage, TextStreamPart, ToolSet } from "ai";
import type { ServerOptions } from "../server";
import {
  buildCardInputSchema,
  buildProposeInterrupt,
  DEFAULT_APPROVAL_WINDOW_MS,
} from "./agui-interrupt";
import {
  buildProposeMutationTool,
  PROPOSE_MUTATION_TOOL_NAME,
  type ProposeMutationArgs,
  proposeMutationInputSchema,
} from "./tools";

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
 * Process-wide default interrupt store (Spec 71 §6.7).
 *
 * Run A (propose) and run B (resume) are separate connections; the store must
 * survive between them. A module singleton bridges them within ONE process —
 * acceptable for single-instance dev/demo only. For multi-instance/production
 * a durable `_linchkit.agui_interrupts` Postgres store MUST be injected
 * (P2b/P5 — the `interruptStore` option below is that seam).
 */
const defaultInterruptStore: InterruptStore = new InMemoryInterruptStore();

/** Extra HITL options for the AG-UI runner (Spec 71 P2a). */
export interface AssistantAgUiRunnerOptions {
  /**
   * Interrupt store (§6.7). Defaults to a process-wide in-memory singleton
   * (dev/demo only). Inject a durable store for production / tests.
   */
  interruptStore?: InterruptStore;
  /** Approval window in ms (§9 risk 7). @default {@link DEFAULT_APPROVAL_WINDOW_MS} */
  approvalWindowMs?: number;
  /**
   * Test/e2e ONLY — override the model `streamText` calls with a deterministic
   * stub (Spec 71 P5 §8 / "CI reliability"). When provided, the runner skips
   * provider resolution (`resolveLanguageModel`) entirely and uses this model,
   * so a browser e2e proving the UI render → click → resume → record chain does
   * NOT depend on a live model deciding to call `proposeMutation`. NEVER set on
   * a real deployment — it is wired only from an explicit test env flag at the
   * boot seam (see routes/agui-api.ts). The value is a Vercel AI SDK
   * `LanguageModel` (the type `resolveLanguageModel` resolves into), e.g. a
   * `MockLanguageModelV3` from `ai/test`.
   */
  modelOverride?: LanguageModel;
}

/**
 * Build the AG-UI agent runner from ServerOptions.
 *
 * Mirrors the `/api/ai/chat` handler in routes/ai-api.ts: same model
 * resolution, actor + tenant scoping, system prompt, read-only tools and
 * multi-step loop — only the output framing differs (AG-UI events).
 *
 * Spec 71 P2a: also exposes the execute-less `proposeMutation` tool, suppresses
 * its tool-call frames at the source (§4.5), and returns an
 * {@link AgUiInterruptDescriptor} when the model proposed a mutation so the
 * endpoint attaches an interrupt outcome to `RUN_FINISHED`.
 */
export function createAssistantAgUiRunner(
  options: ServerOptions,
  hitl: AssistantAgUiRunnerOptions = {},
): AgUiAgentRunner {
  const interruptStore = hitl.interruptStore ?? defaultInterruptStore;
  const approvalWindowMs = hitl.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS;
  const modelOverride = hitl.modelOverride;

  return async ({ input, emit, signal, request }) => {
    const aiConfig = options.aiConfig;
    if (!aiConfig) {
      // routes/agui-api.ts only injects this runner when aiConfig exists.
      throw new Error("AI service is not configured.");
    }

    // ── Spec 71 P2b: RESUME branch (the "resume → execute" half) ──────────
    // When run B carries `input.resume`, this is an approval round-trip, NOT a
    // model turn. The model is never consulted on resume (§6.5: the model never
    // writes; only the resume handler calls `commandLayer.execute`, and only
    // after a human `resolved`). The existing model-turn path below is unchanged
    // when no resume is present.
    if (input.resume && input.resume.length > 0) {
      const { runAgUiResume } = await import("./agui-resume");

      const commandLayer = options.commandLayer;
      if (!commandLayer) {
        // No write engine wired — cannot honor a resume safely. Fail closed.
        throw new Error("CommandLayer is not configured — cannot execute an approved mutation.");
      }

      // §6.3 — re-resolve the run-B actor + tenant from the REQUEST (never trust
      // a client-asserted actor). FAIL CLOSED on the write path: do NOT apply the
      // read-path `?? ANONYMOUS_ACTOR` fallback. When no real authenticated human
      // actor resolves, pass `undefined` — the resume handler then rejects
      // (RUN_ERROR, no execute), never substituting an anonymous/synthetic actor.
      const resumeActor =
        request && options.resolveRequestActor
          ? ((await options.resolveRequestActor(request)) ?? undefined)
          : undefined;
      const resumeTenant =
        request && resumeActor && options.resolveRequestTenantId
          ? await options.resolveRequestTenantId(request, resumeActor)
          : undefined;

      await runAgUiResume({
        threadId: input.threadId,
        resume: input.resume,
        store: interruptStore,
        commandLayer,
        actorContext: { actor: resumeActor, tenant: resumeTenant },
        emit,
      });
      // Resume produced its own TOOL_CALL_RESULT / text frames (or threw on a
      // hard rejection → the endpoint emits RUN_ERROR). Return void so the
      // endpoint emits a plain success finish (declined or executed).
      return undefined;
    }

    // Lazy imports — mirrors ai-api.ts so heavy deps load on first use only.
    const { streamText, stepCountIs, jsonSchema } = await import("ai");
    const { resolveLanguageModel, resolveModel, instrumentRawStream } = await import(
      "@linchkit/cap-ai-provider"
    );
    const { createTenantAwareDataProvider } = await import("@linchkit/core/server");
    const { buildSystemPrompt, extractLocale } = await import("./system-prompt");
    const { buildTools } = await import("./tools");
    const { ANONYMOUS_ACTOR } = await import("../routes/shared");

    const assistantConfig = aiConfig.assistant;
    // P5 §8 / CI reliability: a test-injected deterministic model bypasses
    // provider resolution so the browser e2e never depends on a live model
    // choosing to call `proposeMutation`. Real deployments never set this.
    const model =
      modelOverride ?? (await resolveLanguageModel(aiConfig, assistantConfig?.model ?? "fast"));

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

    // Spec 71 HITL: the runner exposes the execute-less `proposeMutation` tool
    // (below), so the prompt instructs the model to PROPOSE writes via that tool
    // — NOT the old "you cannot write, use the sidebar" refusal. The model still
    // never executes; a proposal surfaces an approval card and a human approval
    // runs the action through CommandLayer (§6.5). `executeAction` stays OFF.
    const systemPrompt = buildSystemPrompt({
      assistantConfig,
      ontologyRegistry: options.ontologyRegistry,
      entityRegistry: options.entityRegistry,
      context: { entity, recordId, locale },
      allowActionExecution: false,
      proposeMutation: true,
    });

    const tools = buildTools({
      dataProvider: scopedProvider,
      commandLayer: options.commandLayer,
      entityRegistry: options.entityRegistry,
      ontologyRegistry: options.ontologyRegistry,
      actor,
      allowActionExecution: false,
    });

    // Spec 71 §4.3: expose the execute-less `proposeMutation` tool alongside the
    // read-only tools. `executeAction` stays OFF (allowActionExecution:false) —
    // proposing ≠ executing (§6.5). Server tools (incl. proposeMutation) win on
    // name collision with any client frontend tool.
    const proposeTool = buildProposeMutationTool();
    const serverTools: ToolSet = { ...tools, ...proposeTool };

    // Client-declared frontend tools (AG-UI `input.tools`) are exposed to
    // the model without an execute fn — their calls stream back to the
    // client as TOOL_CALL_* events. Server tools win on name collision
    // (colliding input tools are skipped inside buildFrontendToolSet).
    const { tools: frontendTools } = buildFrontendToolSet({
      tools: input.tools,
      serverToolNames: new Set(Object.keys(serverTools)),
      toSchema: jsonSchema,
    });

    // Record this streaming generation to the AI trace sink. The runner owns
    // the `streamText` call (tools + multi-step + fullStream translation), so
    // it spreads the SDK's non-throwing onFinish/onError/onAbort callbacks to
    // land the generation in the SAME sink as `completeStream`. See #350.
    const modelAlias = assistantConfig?.model ?? "fast";
    const { provider, modelId } = resolveModel(aiConfig, undefined, modelAlias);
    const temperature = assistantConfig?.temperature ?? 0.3;
    const modelMessages = toModelMessagesFromAgUi(input.messages);
    const trace = instrumentRawStream({
      trace: { name: "assistant-agui", model: modelAlias, tenantId, actorId: actor?.id },
      provider,
      model: modelId,
      messages: modelMessages,
      temperature,
    });

    // Guard construction + iteration so any throw still finalizes the trace
    // (`fail`) instead of leaking the parent opened above. An async stream error
    // already fired `onError` (settling the latch), so `fail` is then a no-op.
    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: modelMessages,
        tools: { ...frontendTools, ...serverTools },
        stopWhen: stepCountIs(assistantConfig?.maxSteps ?? 5),
        temperature,
        abortSignal: signal,
        onFinish: trace.onFinish,
        onError: trace.onError,
        onAbort: trace.onAbort,
      });

      // The captured proposal (if the model called `proposeMutation`). The LAST
      // such call on the run wins — only one proposal is carried per run.
      let proposal: ProposeMutationArgs | undefined;

      for await (const part of result.fullStream) {
        if (signal?.aborted) break; // client went away — stop consuming

        // §4.5 (REQUIRED): suppress the `proposeMutation` tool-call frames at
        // the SOURCE — never emit TOOL_CALL_START/ARGS/END for it, so no raw
        // tool bubble can leak into the chat stream. The proposal surfaces ONLY
        // as the interrupt outcome. Match by tool name (and the consolidated
        // `tool-call` part is the single place its args are knowable). The
        // streaming `tool-input-*` parts for it are already dropped by
        // `streamPartToAgUiEvents`'s default branch, so no separate filter is
        // needed for those.
        if (part.type === "tool-call" && part.toolName === PROPOSE_MUTATION_TOOL_NAME) {
          proposal = parseProposeMutationInput(part.input);
          continue; // do NOT translate/emit — suppressed at the source
        }

        for (const event of streamPartToAgUiEvents(part)) {
          emit(event);
        }
      }

      // Run ended. If the model proposed a mutation, build the interrupt (which
      // also writes the §6.7 store entry) and hand it back to the endpoint so it
      // attaches the interrupt outcome to RUN_FINISHED. Otherwise return void
      // (plain success finish — read-only path unchanged).
      if (proposal) {
        const interrupt = buildProposeInterrupt({
          threadId: input.threadId,
          proposal,
          proposerActor: actor,
          tenant: tenantId,
          store: interruptStore,
          approvalWindowMs,
          actionLabel: actionLabelFor(options, proposal.action),
          // Derive the card's editable-field schema from the ontology so the
          // approval card renders real inputs (approve-with-edits — §8 step 4).
          inputSchema: buildCardInputSchema(options, proposal.action, proposal.input),
        });
        const descriptor: AgUiInterruptDescriptor = { interrupts: [interrupt] };
        return descriptor;
      }
      // No proposal — plain success finish (read-only path unchanged).
      return undefined;
    } catch (streamErr) {
      trace.fail(streamErr);
      throw streamErr;
    }
  };
}

/**
 * Decode a `proposeMutation` tool-call input into the strict `{ action, input }`
 * shape, tolerating the loosely-typed `unknown` the SDK hands for dynamic tools.
 * Returns `undefined` when there is no usable (non-empty) action name: a
 * malformed call with no real action is NOT a proposal — surfacing an interrupt
 * with `action: ""` would write a bogus store entry and show an empty approval
 * card. The run then finishes normally instead. A partial call that still
 * carries a usable action keeps it and drops only the bad input.
 */
export function parseProposeMutationInput(raw: unknown): ProposeMutationArgs | undefined {
  const parsed = proposeMutationInputSchema.safeParse(raw);
  if (parsed.success) {
    const action = parsed.data.action.trim();
    if (!action) return undefined;
    return { action, input: parsed.data.input };
  }
  // Best-effort recovery: keep a usable `action` string, drop bad input. With no
  // non-empty action there is nothing to propose → undefined (no interrupt).
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const action = typeof obj.action === "string" ? obj.action.trim() : "";
  if (!action) return undefined;
  const input =
    typeof obj.input === "object" && obj.input !== null && !Array.isArray(obj.input)
      ? (obj.input as Record<string, unknown>)
      : {};
  return { action, input };
}

/** Resolve a human-friendly action label from the ontology, if available. */
function actionLabelFor(options: ServerOptions, action: string): string | undefined {
  const ontology = options.ontologyRegistry;
  if (!ontology) return undefined;
  // OntologyRegistry has no direct action lookup; scan entities' actions.
  for (const name of ontology.listEntities()) {
    const found = ontology.describe(name)?.actions.find((a) => a.name === action);
    if (found) return found.label;
  }
  return undefined;
}
