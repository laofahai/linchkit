/**
 * FlowStepContext factory
 *
 * Creates a FlowStepContext with real implementations wired to
 * AIService, ActionEngine, and ActionRegistry.
 */

import type { AIBoundary } from "../ai/ai-boundary";
import type { AICallRequest } from "../ai/ai-policy";
import type { ActionDefinition, Actor } from "../types/action";
import type { AICompletionResult, AIService, AITool } from "../types/ai";
import type { FlowStepContext } from "./types";

// ── Dependencies ─────────────────────────────────────────

export interface FlowStepContextDeps {
  aiService: AIService;
  actionEngine: {
    execute: (
      actionName: string,
      input: Record<string, unknown>,
      options?: {
        actor?: Actor;
        tenantId?: string;
        /** Optional idempotency key (Spec 26 §3.2) — forwarded by Saga compensation */
        idempotencyKey?: string;
      },
      // biome-ignore lint/suspicious/noExplicitAny: ActionExecutor returns ActionResult<T> with varying T
    ) => Promise<any>;
  };
  actionRegistry?: {
    get: (name: string) => ActionDefinition | undefined;
  };
  /** Optional AI boundary engine for enforcing rate limits, budgets, and policies */
  aiBoundary?: AIBoundary;
  /** Flow name for boundary audit trail (source tracking) */
  flowName?: string;
}

// ── Field type → JSON Schema type mapping ────────────────

function fieldTypeToJsonSchema(fieldType: string): Record<string, unknown> {
  switch (fieldType) {
    case "string":
    case "text":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
    case "datetime":
      return { type: "string", format: fieldType === "date" ? "date" : "date-time" };
    case "enum":
    case "state":
      return { type: "string" };
    case "json":
      return { type: "object" };
    default:
      return { type: "string" };
  }
}

/**
 * Build AITool definitions from action names by looking them up in the registry.
 * Each action's input fields become the tool's JSON Schema parameters.
 */
function resolveToolsFromActions(
  toolNames: string[],
  registry: { get: (name: string) => ActionDefinition | undefined },
): AITool[] {
  const tools: AITool[] = [];

  for (const name of toolNames) {
    const action = registry.get(name);
    if (!action) {
      // Skip unknown actions — the AI model will simply not have this tool
      continue;
    }

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (action.input) {
      for (const [fieldName, fieldDef] of Object.entries(action.input)) {
        const schema: Record<string, unknown> = fieldTypeToJsonSchema(fieldDef.type);
        if (fieldDef.label) {
          schema.description = fieldDef.label;
        }
        if (fieldDef.description) {
          schema.description = fieldDef.description;
        }
        properties[fieldName] = schema;

        if (fieldDef.required) {
          required.push(fieldName);
        }
      }
    }

    tools.push({
      name: action.name,
      description: action.description ?? action.label,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    });
  }

  return tools;
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create a FlowStepContext with real implementations.
 *
 * - callAI: maps the simple flow interface to AIService.complete()
 * - executeAction: delegates to the action engine
 * - evaluateCondition: simple fallback (returns false)
 */
export function createFlowStepContext(deps: FlowStepContextDeps): FlowStepContext {
  const { aiService, actionEngine, actionRegistry, aiBoundary, flowName } = deps;

  return {
    flowContext: {},

    async callAI(options) {
      const { prompt, model, tools: toolNames, responseFormat } = options;

      // Build tools from action registry if tool names are provided
      let aiTools: AITool[] | undefined;
      if (toolNames && toolNames.length > 0 && actionRegistry) {
        aiTools = resolveToolsFromActions(toolNames, actionRegistry);
        if (aiTools.length === 0) {
          aiTools = undefined;
        }
      }

      // Build response format for AIService
      let aiResponseFormat:
        | { type: "text" }
        | { type: "json"; schema: import("zod").ZodSchema }
        | undefined;
      if (responseFormat?.type === "json" && responseFormat.schema) {
        // Parse the schema string as JSON and wrap in a pass-through Zod schema
        // The AI service expects a Zod schema for structured output, but flow definitions
        // use a JSON string. We import zod dynamically to create a passthrough schema.
        try {
          const parsed = JSON.parse(responseFormat.schema);
          const { z } = await import("zod");
          // Use z.object with passthrough to accept any shape matching the JSON schema
          // This is a best-effort bridge — full JSON Schema → Zod conversion is out of scope
          aiResponseFormat = {
            type: "json" as const,
            schema: z.object({}).passthrough().describe(JSON.stringify(parsed)),
          };
        } catch {
          // If parsing fails, skip response format and let the model respond freely
          aiResponseFormat = undefined;
        }
      }

      const completionOptions = {
        messages: [{ role: "user" as const, content: prompt }],
        model,
        tools: aiTools,
        responseFormat: aiResponseFormat,
      };

      // If AIBoundary is configured, route through it for policy enforcement
      let result: AICompletionResult;
      if (aiBoundary) {
        const callRequest: AICallRequest = {
          source: "flow",
          tenantId: this.tenantId,
          actorId: this.actor?.id,
          promptContent: prompt,
          actionName: flowName,
        };
        result = await aiBoundary.execute(completionOptions, callRequest);
      } else {
        result = await aiService.complete(completionOptions);
      }

      return {
        response: result.content,
        tokensUsed: result.usage.totalTokens,
        toolCalls: result.toolCalls?.map((tc) => ({
          toolName: tc.toolName,
          args: tc.args,
        })),
      };
    },

    async executeAction(actionName, input, options) {
      // Use the flow's actor/tenant when available, fall back to system actor
      const actor = this.actor ?? {
        type: "system",
        id: "flow-engine",
        name: "Flow Engine",
        groups: [],
      };
      const result = await actionEngine.execute(actionName, input, {
        actor,
        tenantId: this.tenantId,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      // ActionExecutor returns ActionResult with { success, data, executionId }
      if (typeof result === "object" && result !== null && "success" in result) {
        if (!result.success) {
          const errorMsg =
            typeof result.error === "string" ? result.error : `Action '${actionName}' failed`;
          throw new Error(errorMsg);
        }
        return (result.data as Record<string, unknown>) ?? {};
      }
      return result as Record<string, unknown>;
    },

    evaluateCondition(_expression, _context) {
      // Simple fallback — the sync-engine already handles basic expressions
      // via evaluateSimpleExpression(). This is the final fallback for
      // declarative conditions that don't match simple patterns.
      return false;
    },
  };
}
