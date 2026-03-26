/**
 * Synchronous Flow Engine — simple fallback for when Restate is not available
 *
 * Runs flow steps sequentially without durability guarantees.
 * Suitable for development, prototyping, and simple flows that don't
 * require human approval gates or durable execution.
 *
 * Limitations:
 * - No durability — if the process crashes, in-flight flows are lost
 * - Approval/wait steps throw an error (they require Restate)
 * - Parallel steps run sequentially (with a warning)
 */

import type { Actor, ActorType } from "../types/action";
import type { EventBusLike } from "../types/event";
import type {
  ActionFlowStep,
  AIFlowStep,
  ConditionFlowStep,
  FlowDefinition,
  FlowInstance,
  FlowStep,
  ParallelFlowStep,
} from "../types/flow";
import { emitFlowCompletionEvent, processOnCompleteChains } from "./flow-chaining";
import type { FlowEngine, FlowRegistry, FlowStepContext } from "./types";

// ── Expression resolver ─────────────────────────────────

/**
 * Resolve input expressions like `$prev.output.xxx` or `$steps.stepId.xxx`
 * from accumulated flow context.
 */
function resolveInputExpressions(
  input: Record<string, unknown> | string | undefined,
  flowContext: Record<string, unknown>,
): Record<string, unknown> {
  if (!input) return {};

  if (typeof input === "string") {
    // Single expression string — resolve to the value
    const resolved = resolveExpression(input, flowContext);
    if (typeof resolved === "object" && resolved !== null) {
      return resolved as Record<string, unknown>;
    }
    return { value: resolved };
  }

  // Object with potentially expression-valued fields
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.startsWith("$")) {
      result[key] = resolveExpression(value, flowContext);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve a single `$`-prefixed expression against the flow context.
 *
 * Supported patterns:
 * - `$prev.output.fieldName` — previous step's output
 * - `$steps.stepId.fieldName` — specific step's output
 * - `$input.fieldName` — flow input
 */
function resolveExpression(expr: string, flowContext: Record<string, unknown>): unknown {
  if (!expr.startsWith("$")) return expr;

  const parts = expr.split(".");
  let current: unknown = flowContext;

  // Map $-prefixed roots to internal keys
  const root = parts[0];
  if (root === "$prev") {
    parts[0] = "__prev";
  } else if (root === "$steps") {
    parts[0] = "__steps";
  } else if (root === "$input") {
    parts[0] = "__input";
  } else if (root === "$flow") {
    parts[0] = "__flow";
  } else {
    // Unknown prefix — return as-is
    return expr;
  }

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// ── Condition expression evaluator ──────────────────────

/**
 * Evaluate a simple condition expression for flow branching.
 *
 * Supports basic comparisons against flow context values:
 * - `$prev.output.amount > 10000`
 * - `$steps.validate.status == "approved"`
 *
 * Falls back to the stepContext.evaluateCondition() for complex cases.
 */
function evaluateSimpleExpression(
  expression: string,
  flowContext: Record<string, unknown>,
  stepContext: FlowStepContext,
): boolean {
  // Try simple comparison patterns: <expr> <op> <value>
  const comparisonMatch = expression.match(/^(\$[\w.]+)\s*(===?|!==?|>=?|<=?|==)\s*(.+)$/);

  if (comparisonMatch) {
    const [, leftExpr, op, rightRaw] = comparisonMatch;
    const left = resolveExpression(leftExpr ?? "", flowContext);

    // Parse right-hand value
    let right: unknown = (rightRaw ?? "").trim();
    if (right === "true") right = true;
    else if (right === "false") right = false;
    else if (right === "null") right = null;
    else if ((right as string).startsWith('"') && (right as string).endsWith('"')) {
      right = (right as string).slice(1, -1);
    } else if ((right as string).startsWith("'") && (right as string).endsWith("'")) {
      right = (right as string).slice(1, -1);
    } else if (!Number.isNaN(Number(right))) {
      right = Number(right);
    }

    switch (op) {
      case "==":
      case "===":
        return left === right;
      case "!=":
      case "!==":
        return left !== right;
      case ">":
        return typeof left === "number" && typeof right === "number" && left > right;
      case ">=":
        return typeof left === "number" && typeof right === "number" && left >= right;
      case "<":
        return typeof left === "number" && typeof right === "number" && left < right;
      case "<=":
        return typeof left === "number" && typeof right === "number" && left <= right;
    }
  }

  // Fallback: use stepContext's evaluateCondition for declarative conditions
  return stepContext.evaluateCondition(expression, flowContext);
}

// ── Step executors ──────────────────────────────────────

async function executeActionStep(
  step: ActionFlowStep,
  stepContext: FlowStepContext,
  flowContext: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = resolveInputExpressions(step.input, flowContext);
  return stepContext.executeAction(step.actionName, input);
}

/** Maximum number of tool call rounds to prevent infinite loops */
const MAX_TOOL_CALL_ROUNDS = 10;

/**
 * Resolve a prompt string or template against the flow context.
 */
function resolvePrompt(
  prompt: string | { template: string; variables: Record<string, string> },
  flowContext: Record<string, unknown>,
): string {
  if (typeof prompt === "string") {
    // Replace $-expressions in the prompt string
    return prompt.replace(/\$[\w.]+/g, (match) => {
      const value = resolveExpression(match, flowContext);
      return value !== undefined ? String(value) : match;
    });
  }

  // Template with variables
  let result = prompt.template;
  for (const [key, expr] of Object.entries(prompt.variables)) {
    const value = resolveExpression(expr, flowContext);
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value ?? ""));
  }
  return result;
}

async function executeAIStep(
  step: AIFlowStep,
  stepContext: FlowStepContext,
  flowContext: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prompt = resolvePrompt(step.prompt, flowContext);

  const result = await stepContext.callAI({
    prompt,
    model: step.model,
    tools: step.tools,
    responseFormat: step.responseFormat,
  });

  // If no tool calls, return immediately
  if (!result.toolCalls || result.toolCalls.length === 0) {
    return { response: result.response, tokensUsed: result.tokensUsed };
  }

  // Tool call loop: execute tool calls and feed results back to AI
  let totalTokens = result.tokensUsed;
  const toolResults: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }> =
    [];
  let currentToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> | undefined =
    result.toolCalls;
  let finalResponse = result.response;
  let round = 0;

  while (currentToolCalls && currentToolCalls.length > 0 && round < MAX_TOOL_CALL_ROUNDS) {
    round++;

    // Execute each tool call via executeAction
    const roundResults: Array<{ toolName: string; result: unknown }> = [];
    for (const toolCall of currentToolCalls) {
      try {
        const actionResult = await stepContext.executeAction(toolCall.toolName, toolCall.args);
        roundResults.push({ toolName: toolCall.toolName, result: actionResult });
        toolResults.push({
          toolName: toolCall.toolName,
          args: toolCall.args,
          result: actionResult,
        });
      } catch (err) {
        const errorResult = {
          error: err instanceof Error ? err.message : String(err),
        };
        roundResults.push({ toolName: toolCall.toolName, result: errorResult });
        toolResults.push({
          toolName: toolCall.toolName,
          args: toolCall.args,
          result: errorResult,
        });
      }
    }

    // Build a follow-up prompt with tool results for the AI
    const toolResultSummary = roundResults
      .map((r) => `Tool "${r.toolName}" returned: ${JSON.stringify(r.result)}`)
      .join("\n");

    const followUpPrompt = `${prompt}\n\nPrevious tool call results:\n${toolResultSummary}\n\nPlease provide your final response based on these results.`;

    const followUp = await stepContext.callAI({
      prompt: followUpPrompt,
      model: step.model,
      tools: step.tools,
      responseFormat: step.responseFormat,
    });

    totalTokens += followUp.tokensUsed;
    finalResponse = followUp.response;
    currentToolCalls = followUp.toolCalls;
  }

  return {
    response: finalResponse,
    tokensUsed: totalTokens,
    toolCalls: toolResults,
  };
}

// ── SyncFlowEngine ──────────────────────────────────────

/**
 * Create a synchronous flow engine that runs steps sequentially in memory.
 *
 * This engine does NOT support:
 * - `approval` steps (throws an error)
 * - `wait` steps (throws an error)
 * - Durability (flows are lost on crash)
 *
 * It DOES support:
 * - `action` steps
 * - `condition` steps (branching)
 * - `ai` steps
 * - `parallel` steps (run sequentially with a warning)
 */
export function createSyncFlowEngine(
  stepContext: FlowStepContext,
  options?: {
    eventBus?: EventBusLike & { emit?: (event: import("../types/event").EventRecord) => Promise<void> };
    flowRegistry?: FlowRegistry;
  },
): FlowEngine {
  /** In-memory registry of flow definitions */
  const flowDefs = new Map<string, FlowDefinition>();

  /** In-memory store of flow instances */
  const instances = new Map<string, FlowInstance>();

  /** Build a step lookup map for the given flow */
  function buildStepMap(steps: FlowStep[]): Map<string, FlowStep> {
    const map = new Map<string, FlowStep>();
    for (const step of steps) {
      map.set(step.id, step);
    }
    return map;
  }

  /**
   * Execute a single flow step and return its output.
   */
  async function executeStep(
    step: FlowStep,
    flowContext: Record<string, unknown>,
    stepMap: Map<string, FlowStep>,
    runCtx: FlowStepContext,
  ): Promise<{ output: Record<string, unknown>; nextStepId?: string }> {
    switch (step.type) {
      case "action": {
        const output = await executeActionStep(step, runCtx, flowContext);
        return { output };
      }

      case "ai": {
        const output = await executeAIStep(step, runCtx, flowContext);
        return { output };
      }

      case "condition": {
        const condStep = step as ConditionFlowStep;
        const result = evaluateSimpleExpression(condStep.expression, flowContext, runCtx);
        const nextStepId = result ? condStep.then : condStep.else;
        return { output: { result }, nextStepId };
      }

      case "parallel": {
        const parallelStep = step as ParallelFlowStep;
        console.warn(
          `[SyncFlowEngine] Parallel step "${step.id}" — running ${parallelStep.steps.length} sub-steps sequentially (Restate required for true parallelism)`,
        );

        const outputs: Record<string, unknown> = {};
        for (const subStepId of parallelStep.steps) {
          const subStep = stepMap.get(subStepId);
          if (!subStep) {
            throw new Error(`Parallel sub-step "${subStepId}" not found in flow definition`);
          }
          const { output } = await executeStep(subStep, flowContext, stepMap, runCtx);
          outputs[subStepId] = output;
          // Update context for subsequent sub-steps
          const stepsCtx = flowContext.__steps as Record<string, unknown>;
          stepsCtx[subStepId] = output;
          flowContext.__prev = { output };
        }
        return { output: outputs };
      }

      case "approval":
        throw new Error(
          `Approval step "${step.id}" requires Restate server. ` +
            "Configure restate in your LinchKit config to use approval/wait steps.",
        );

      case "wait":
        throw new Error(
          `Wait step "${step.id}" requires Restate server. ` +
            "Configure restate in your LinchKit config to use approval/wait steps.",
        );

      default:
        throw new Error(`Unknown step type: ${(step as FlowStep).type}`);
    }
  }

  /**
   * Run a flow from start to completion.
   */
  async function runFlow(
    definition: FlowDefinition,
    input: Record<string, unknown>,
    instanceId: string,
    runOptions?: { tenantId?: string; actor?: Actor },
  ): Promise<FlowInstance> {
    const stepMap = buildStepMap(definition.steps);

    // Initialize flow context
    const flowContext: Record<string, unknown> = {
      __input: input,
      __steps: {} as Record<string, unknown>,
      __prev: { output: input },
      __flow: { instanceId },
    };

    // Create instance
    const instance: FlowInstance = {
      id: instanceId,
      flowName: definition.name,
      status: "running",
      currentStepId: definition.steps[0]?.id ?? "",
      context: flowContext,
      startedAt: new Date(),
    };
    instances.set(instanceId, instance);

    // Create per-run context to avoid cross-flow contamination when
    // multiple flows run concurrently (each gets its own tenant/actor/flowContext).
    const runCtx: FlowStepContext = {
      ...stepContext,
      tenantId: runOptions?.tenantId,
      actor: runOptions?.actor,
      flowContext,
    };

    try {
      // Walk through steps sequentially
      let stepIndex = 0;

      while (stepIndex < definition.steps.length) {
        const step = definition.steps[stepIndex];
        if (!step) break;
        instance.currentStepId = step.id;

        const { output, nextStepId } = await executeStep(step, flowContext, stepMap, runCtx);

        // Store step output in context (wrapped in { output } to match compiler format)
        const stepsCtx = flowContext.__steps as Record<string, unknown>;
        stepsCtx[step.id] = { output };
        flowContext.__prev = { output };

        // Handle branching (condition steps may jump to a specific step)
        if (nextStepId !== undefined) {
          // Find the target step index
          const targetIndex = definition.steps.findIndex((s) => s.id === nextStepId);
          if (targetIndex === -1) {
            throw new Error(
              `Condition step "${step.id}" targets non-existent step "${nextStepId}"`,
            );
          }
          stepIndex = targetIndex;
        } else {
          stepIndex++;
        }
      }

      // Flow completed successfully
      instance.status = "completed";
      instance.completedAt = new Date();
      instance.context = flowContext;
    } catch (err) {
      instance.status = "failed";
      instance.completedAt = new Date();
      instance.error = {
        stepId: instance.currentStepId,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Emit flow completion/failure event to EventBus
    if (options?.eventBus && (instance.status === "completed" || instance.status === "failed")) {
      try {
        await emitFlowCompletionEvent(options.eventBus, instance);
      } catch {
        // Don't fail the flow if event emission fails
      }
    }

    // Process explicit onComplete chains (only via flowRegistry, not self-reference)
    if (options?.flowRegistry && instance.status === "completed") {
      try {
        await processOnCompleteChains(instance, options.flowRegistry, engine);
      } catch (chainErr) {
        // Don't fail the parent flow if chaining fails
        console.warn(
          `[SyncFlowEngine] onComplete chain failed for flow "${instance.flowName}": ${chainErr instanceof Error ? chainErr.message : String(chainErr)}`,
        );
      }
    }

    return instance;
  }

  // ── FlowEngine interface ────────────────────────────────

  const engine: FlowEngine = {
    async startFlow(flowName, input, startOptions) {
      const definition = flowDefs.get(flowName);
      if (!definition) {
        throw new Error(`Flow "${flowName}" is not registered`);
      }

      const instanceId = startOptions?.instanceId ?? crypto.randomUUID();
      const tenantId = startOptions?.tenantId;
      let actor: Actor | undefined;
      if (startOptions?.actor) {
        const optActor = startOptions.actor;
        if ("groups" in optActor && optActor.groups) {
          actor = optActor as Actor;
        } else {
          actor = {
            type: optActor.type as ActorType,
            id: optActor.id,
            name: "name" in optActor ? optActor.name : undefined,
            groups: [],
          };
        }
      }
      return runFlow(definition, input, instanceId, {
        tenantId,
        actor,
      });
    },

    async getFlowStatus(instanceId) {
      return instances.get(instanceId) ?? null;
    },

    async sendSignal(_instanceId, _signalName, _data) {
      throw new Error(
        "SyncFlowEngine does not support signals. " +
          "Configure Restate for durable flows with approval/wait steps.",
      );
    },

    async cancelFlow(instanceId) {
      const instance = instances.get(instanceId);
      if (instance && instance.status === "running") {
        instance.status = "cancelled";
        instance.completedAt = new Date();
      }
    },

    registerFlow(definition: FlowDefinition) {
      flowDefs.set(definition.name, definition);
    },
  };

  return engine;
}
