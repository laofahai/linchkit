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

import type {
  ActionFlowStep,
  AIFlowStep,
  ConditionFlowStep,
  FlowDefinition,
  FlowInstance,
  FlowStep,
  ParallelFlowStep,
} from "../../types/flow";
import type { FlowEngine, FlowStepContext } from "./types";

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

  // Map $prev → the __prev key, $steps → __steps, $input → __input
  const root = parts[0];
  if (root === "$prev") {
    parts[0] = "__prev";
  } else if (root === "$steps") {
    parts[0] = "__steps";
  } else if (root === "$input") {
    parts[0] = "__input";
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

async function executeAIStep(
  step: AIFlowStep,
  stepContext: FlowStepContext,
  flowContext: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Resolve prompt template variables
  let prompt: string;
  if (typeof step.prompt === "string") {
    prompt = step.prompt;
    // Replace $-expressions in the prompt string
    prompt = prompt.replace(/\$[\w.]+/g, (match) => {
      const value = resolveExpression(match, flowContext);
      return value !== undefined ? String(value) : match;
    });
  } else {
    // Template with variables
    prompt = step.prompt.template;
    for (const [key, expr] of Object.entries(step.prompt.variables)) {
      const value = resolveExpression(expr, flowContext);
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), String(value ?? ""));
    }
  }

  const result = await stepContext.callAI({
    prompt,
    model: step.model,
    tools: step.tools,
    responseFormat: step.responseFormat,
  });

  return { response: result.response, tokensUsed: result.tokensUsed };
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
export function createSyncFlowEngine(stepContext: FlowStepContext): FlowEngine {
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
  ): Promise<{ output: Record<string, unknown>; nextStepId?: string }> {
    switch (step.type) {
      case "action": {
        const output = await executeActionStep(step, stepContext, flowContext);
        return { output };
      }

      case "ai": {
        const output = await executeAIStep(step, stepContext, flowContext);
        return { output };
      }

      case "condition": {
        const condStep = step as ConditionFlowStep;
        const result = evaluateSimpleExpression(condStep.expression, flowContext, stepContext);
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
          const { output } = await executeStep(subStep, flowContext, stepMap);
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
    options?: { tenantId?: string; actor?: { type: string; id: string } },
  ): Promise<FlowInstance> {
    const stepMap = buildStepMap(definition.steps);

    // Initialize flow context
    const flowContext: Record<string, unknown> = {
      __input: input,
      __steps: {} as Record<string, unknown>,
      __prev: { output: input },
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

    // Provide tenant/actor to stepContext
    stepContext.tenantId = options?.tenantId;
    stepContext.actor = options?.actor;
    stepContext.flowContext = flowContext;

    try {
      // Walk through steps sequentially
      let stepIndex = 0;

      while (stepIndex < definition.steps.length) {
        const step = definition.steps[stepIndex];
        if (!step) break;
        instance.currentStepId = step.id;

        const { output, nextStepId } = await executeStep(step, flowContext, stepMap);

        // Store step output in context
        const stepsCtx = flowContext.__steps as Record<string, unknown>;
        stepsCtx[step.id] = output;
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

    return instance;
  }

  // ── FlowEngine interface ────────────────────────────────

  return {
    async startFlow(flowName, input, options) {
      const definition = flowDefs.get(flowName);
      if (!definition) {
        throw new Error(`Flow "${flowName}" is not registered`);
      }

      const instanceId = options?.instanceId ?? crypto.randomUUID();
      return runFlow(definition, input, instanceId, options);
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

    // Expose registry methods for the sync engine (non-interface, cast-safe)
    registerFlow(definition: FlowDefinition) {
      flowDefs.set(definition.name, definition);
    },
  } as FlowEngine & { registerFlow(definition: FlowDefinition): void };
}
