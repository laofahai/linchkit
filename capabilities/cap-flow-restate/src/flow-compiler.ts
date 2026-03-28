/**
 * FlowCompiler — compiles FlowDefinition DSL into Restate workflow handlers.
 *
 * Takes a declarative FlowDefinition and produces a Restate workflow service
 * with a `run` handler (sequential step execution with branching), signal
 * handlers for approval steps, and a status query handler.
 */
import * as restate from "@restatedev/restate-sdk";

import type {
  ActionFlowStep,
  AIFlowStep,
  ApprovalFlowStep,
  ConditionFlowStep,
  FlowDefinition,
  FlowStep,
  ParallelFlowStep,
  WaitFlowStep,
} from "@linchkit/core";
import type { FlowStepContext } from "@linchkit/core/server";
import type { CompiledFlow } from "./types";

// ── Expression resolution ────────────────────────────────

/** Runtime context accumulated during flow execution */
interface FlowExecutionContext {
  /** Original flow input */
  input: Record<string, unknown>;
  /** Flow instance ID */
  instanceId: string;
  /** Output of the previous step */
  prev: { output: unknown } | null;
  /** Outputs indexed by step ID */
  steps: Record<string, { output: unknown }>;
}

/**
 * Resolve an expression string or static object against the flow execution context.
 *
 * Expression patterns:
 * - `$prev.output.xxx` — previous step's output
 * - `$steps.{stepId}.output.xxx` — specific step's output
 * - `$input.xxx` — original flow input
 * - `$flow.instanceId` — current flow instance ID
 * - Static objects pass through unchanged
 */
function resolveExpression(
  expr: string | Record<string, unknown> | undefined,
  context: FlowExecutionContext,
): Record<string, unknown> {
  if (expr === undefined) return {};

  // Static object — resolve any string values that look like expressions
  if (typeof expr === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(expr)) {
      if (typeof value === "string" && value.startsWith("$")) {
        resolved[key] = resolvePathValue(value, context);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  // Single expression string — resolve to a value, wrap in object
  const value = resolvePathValue(expr, context);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Resolve a dot-path expression (e.g., "$prev.output.amount") to a value.
 */
function resolvePathValue(path: string, context: FlowExecutionContext): unknown {
  if (!path.startsWith("$")) return path;

  const parts = path.split(".");
  const root = parts[0];

  let current: unknown;
  switch (root) {
    case "$prev":
      current = context.prev;
      break;
    case "$steps":
      current = context.steps;
      break;
    case "$input":
      current = context.input;
      // "$input.xxx" — skip the "$input" prefix, drill into input directly
      return drillDown(current, parts.slice(1));
    case "$flow":
      current = { instanceId: context.instanceId };
      return drillDown(current, parts.slice(1));
    default:
      return path;
  }

  // For $prev and $steps, skip the root and drill
  return drillDown(current, parts.slice(1));
}

function drillDown(obj: unknown, parts: string[]): unknown {
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Resolve an AI prompt template. Supports both plain string and
 * `{ template, variables }` format.
 */
function resolvePrompt(
  prompt: string | { template: string; variables: Record<string, string> },
  context: FlowExecutionContext,
): string {
  if (typeof prompt === "string") {
    // Replace $-prefixed tokens in the string
    return prompt.replace(/\$[\w.]+/g, (match) => {
      const value = resolvePathValue(match, context);
      return String(value ?? match);
    });
  }

  // Template with variable substitutions
  let result = prompt.template;
  for (const [key, expr] of Object.entries(prompt.variables)) {
    const value = resolvePathValue(expr, context);
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value ?? ""));
  }
  return result;
}

// ── Step execution ───────────────────────────────────────

/**
 * Result returned by the flow's run handler.
 */
interface FlowRunResult {
  status: "completed" | "rejected" | "timeout_rejected" | "escalated";
  stepId?: string;
  approver?: string;
  output?: unknown;
}

// ── Compiler ─────────────────────────────────────────────

/**
 * Compile a FlowDefinition into a Restate workflow service.
 *
 * The compiled workflow has:
 * - A `run` handler that executes steps sequentially with branching
 * - Signal handlers for each approval step (named `approve_{stepId}`)
 * - A `status` handler for querying current state
 * - A `signal` handler for sending arbitrary signals (for WaitFlowStep.signal)
 */
export function compileFlow(
  definition: FlowDefinition,
  stepContext: FlowStepContext,
): CompiledFlow {
  const { steps } = definition;

  // Build step index for O(1) lookups by step ID
  const stepIndex = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step) stepIndex.set(step.id, i);
  }

  // Collect approval steps and wait-signal steps for handler generation
  const approvalSteps = steps.filter((s): s is ApprovalFlowStep => s.type === "approval");
  const signalHandlerNames = approvalSteps.map((s) => `approve_${s.id}`);

  // Check if any wait steps use signals — if so, we need a generic signal handler
  const hasSignalWaits = steps.some((s) => s.type === "wait" && (s as WaitFlowStep).signal);
  if (hasSignalWaits) {
    signalHandlerNames.push("signal");
  }

  // Always include status handler
  signalHandlerNames.push("status");

  // ── Build handlers object ──────────────────────────────

  // biome-ignore lint: Dynamic handler map — typed as any to support heterogeneous Restate handler signatures
  const handlers: Record<string, any> = {};

  // Main run handler
  handlers.run = async (
    ctx: restate.WorkflowContext,
    input: Record<string, unknown>,
  ): Promise<FlowRunResult> => {
    const flowCtx: FlowExecutionContext = {
      input,
      instanceId: ctx.key,
      prev: null,
      steps: {},
    };

    ctx.set("status", "running");

    let pointer = 0;

    while (pointer < steps.length) {
      const step = steps[pointer];
      if (!step) break;
      ctx.set("current_step", step.id);

      const result = await executeStep(
        ctx,
        step,
        stepIndex,
        steps,
        flowCtx,
        stepContext,
        definition.name,
      );

      // Handle jump instructions from condition/approval steps
      if (
        result !== undefined &&
        typeof result === "object" &&
        result !== null &&
        "__jump" in result
      ) {
        const jumpTarget = (result as { __jump: string }).__jump;
        const targetIndex = stepIndex.get(jumpTarget);
        if (targetIndex === undefined) {
          throw new restate.TerminalError(`Jump target step "${jumpTarget}" not found`);
        }
        pointer = targetIndex;
        continue;
      }

      // Handle early termination (rejection, timeout)
      if (
        result !== undefined &&
        typeof result === "object" &&
        result !== null &&
        "__terminate" in result
      ) {
        const termination = (result as { __terminate: FlowRunResult }).__terminate;
        ctx.set("status", termination.status);
        return termination;
      }

      // Store step output
      const output = result;
      flowCtx.steps[step.id] = { output };
      flowCtx.prev = { output };

      pointer++;
    }

    ctx.set("status", "completed");
    return {
      status: "completed",
      output: flowCtx.prev?.output,
    };
  };

  // Status query handler
  handlers.status = async (ctx: restate.WorkflowSharedContext): Promise<string> => {
    return (await ctx.get<string>("status")) ?? "unknown";
  };

  // Generate approval signal handlers
  for (const step of approvalSteps) {
    handlers[`approve_${step.id}`] = async (
      ctx: restate.WorkflowSharedContext,
      data: { approved: boolean; approver: string },
    ): Promise<{ acknowledged: boolean }> => {
      // Use DurablePromise to deliver approval data (works even if workflow hasn't reached the step yet)
      await ctx
        .promise<{ approved: boolean; approver: string }>(`approval_${step.id}`)
        .resolve(data);
      return { acknowledged: true };
    };
  }

  // Timeout handler — called by delayed self-call to reject approval DurablePromise
  if (approvalSteps.some((s) => s.timeout)) {
    handlers._timeout_approval = async (
      ctx: restate.WorkflowSharedContext,
      data: { stepId: string },
    ): Promise<void> => {
      await ctx.promise(`approval_${data.stepId}`).reject("Approval timed out");
    };
    signalHandlerNames.push("_timeout_approval");
  }

  // Generic signal handler for WaitFlowStep.signal
  if (hasSignalWaits) {
    handlers.signal = async (
      ctx: restate.WorkflowSharedContext,
      data: { name: string; payload: unknown },
    ): Promise<{ acknowledged: boolean }> => {
      const awakeableId = await ctx.get<string>(`awakeable_signal_${data.name}`);
      if (!awakeableId) {
        throw new restate.TerminalError(`No pending signal: ${data.name}`);
      }
      ctx.resolveAwakeable(awakeableId, data.payload);
      return { acknowledged: true };
    };
  }

  // Create the Restate workflow service.
  // Handlers are dynamically built so we cast to satisfy restate.workflow() signature.
  const restateService = restate.workflow({
    name: definition.name,
    // biome-ignore lint/suspicious/noExplicitAny: handlers built dynamically from FlowDefinition steps
    handlers: handlers as any,
  });

  return {
    definition,
    restateService,
    signalHandlers: signalHandlerNames,
  };
}

// ── Individual step executors ────────────────────────────

/**
 * Execute a single flow step. Returns the step output, or a special
 * `__jump` / `__terminate` instruction object for control flow.
 */
async function executeStep(
  ctx: restate.WorkflowContext,
  step: FlowStep,
  stepIndex: Map<string, number>,
  steps: FlowStep[],
  flowCtx: FlowExecutionContext,
  stepContext: FlowStepContext,
  workflowName: string,
): Promise<unknown> {
  switch (step.type) {
    case "action":
      return executeActionStep(ctx, step, flowCtx, stepContext);
    case "condition":
      return executeConditionStep(step, flowCtx, stepContext);
    case "approval":
      return executeApprovalStep(ctx, step, workflowName);
    case "ai":
      return executeAIStep(ctx, step, flowCtx, stepContext);
    case "wait":
      return executeWaitStep(ctx, step);
    case "parallel":
      return executeParallelStep(ctx, step, stepIndex, steps, flowCtx, stepContext);
    default:
      throw new restate.TerminalError(`Unknown step type: ${(step as FlowStep).type}`);
  }
}

async function executeActionStep(
  ctx: restate.WorkflowContext,
  step: ActionFlowStep,
  flowCtx: FlowExecutionContext,
  stepContext: FlowStepContext,
): Promise<unknown> {
  const resolvedInput = resolveExpression(step.input, flowCtx);
  return ctx.run(step.id, () => stepContext.executeAction(step.actionName, resolvedInput));
}

function executeConditionStep(
  step: ConditionFlowStep,
  flowCtx: FlowExecutionContext,
  stepContext: FlowStepContext,
): { __jump: string } | undefined {
  // Build a flat context object for condition evaluation
  const evalContext: Record<string, unknown> = {
    ...flowCtx.input,
    prev: flowCtx.prev,
    steps: flowCtx.steps,
    flow: { instanceId: flowCtx.instanceId },
  };

  const result = stepContext.evaluateCondition(step.expression, evalContext);

  if (result) {
    return { __jump: step.then };
  }
  if (step.else) {
    return { __jump: step.else };
  }
  // No else branch — fall through to next step
  return undefined;
}

async function executeApprovalStep(
  ctx: restate.WorkflowContext,
  step: ApprovalFlowStep,
  workflowName: string,
): Promise<unknown> {
  // DurablePromise is race-safe: resolve() can be called before or after await.
  // For timeout: schedule a delayed self-call that rejects the promise after the specified duration.
  ctx.set("status", `waiting_approval:${step.id}`);

  // Schedule timeout rejection via delayed self-call
  if (step.timeout) {
    ctx.genericSend({
      service: workflowName,
      method: "_timeout_approval",
      key: ctx.key,
      parameter: { stepId: step.id },
      delay: step.timeout,
    });
  }

  let approval: { approved: boolean; approver: string };
  try {
    approval = await ctx.promise<{ approved: boolean; approver: string }>(`approval_${step.id}`);
  } catch {
    // DurablePromise was rejected (timeout or explicit rejection)
    switch (step.onTimeout) {
      case "skip":
        return undefined;
      case "escalate":
        return { __terminate: { status: "escalated" as const, stepId: step.id } };
      default:
        return { __terminate: { status: "timeout_rejected" as const, stepId: step.id } };
    }
  }

  if (!approval.approved) {
    if (step.onRejection) {
      return { __jump: step.onRejection };
    }
    return {
      __terminate: {
        status: "rejected" as const,
        stepId: step.id,
        approver: approval.approver,
      },
    };
  }

  // Approved — return approval data as step output
  return { approved: true, approver: approval.approver };
}

/** Maximum number of tool call rounds to prevent infinite loops */
const MAX_TOOL_CALL_ROUNDS = 10;

async function executeAIStep(
  ctx: restate.WorkflowContext,
  step: AIFlowStep,
  flowCtx: FlowExecutionContext,
  stepContext: FlowStepContext,
): Promise<unknown> {
  const prompt = resolvePrompt(step.prompt, flowCtx);

  // Initial AI call (durable)
  const result = await ctx.run(`${step.id}_ai`, () =>
    stepContext.callAI({
      prompt,
      model: step.model,
      tools: step.tools,
      responseFormat: step.responseFormat,
    }),
  );

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

    // Execute each tool call via executeAction (each durable)
    const roundResults: Array<{ toolName: string; result: unknown }> = [];
    for (const toolCall of currentToolCalls) {
      const actionResult = await ctx.run(
        `${step.id}_tool_${round}_${toolCall.toolName}`,
        async () => {
          try {
            return await stepContext.executeAction(toolCall.toolName, toolCall.args);
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      );
      roundResults.push({ toolName: toolCall.toolName, result: actionResult });
      toolResults.push({ toolName: toolCall.toolName, args: toolCall.args, result: actionResult });
    }

    // Build follow-up prompt with tool results
    const toolResultSummary = roundResults
      .map((r) => `Tool "${r.toolName}" returned: ${JSON.stringify(r.result)}`)
      .join("\n");

    const followUpPrompt = `${prompt}\n\nPrevious tool call results:\n${toolResultSummary}\n\nPlease provide your final response based on these results.`;

    // Follow-up AI call (durable)
    const followUp = await ctx.run(`${step.id}_ai_${round}`, () =>
      stepContext.callAI({
        prompt: followUpPrompt,
        model: step.model,
        tools: step.tools,
        responseFormat: step.responseFormat,
      }),
    );

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

async function executeWaitStep(ctx: restate.WorkflowContext, step: WaitFlowStep): Promise<unknown> {
  if (step.duration) {
    await ctx.sleep(step.duration, `wait_${step.id}`);
    return undefined;
  }

  if (step.signal) {
    const { id: awakeableId, promise } = ctx.awakeable();
    ctx.set(`awakeable_signal_${step.signal}`, awakeableId);
    ctx.set("status", `waiting_signal:${step.signal}`);
    const payload = await promise;
    return payload;
  }

  // Neither duration nor signal — no-op
  return undefined;
}

async function executeParallelStep(
  ctx: restate.WorkflowContext,
  step: ParallelFlowStep,
  stepIndex: Map<string, number>,
  steps: FlowStep[],
  flowCtx: FlowExecutionContext,
  stepContext: FlowStepContext,
): Promise<unknown> {
  // Resolve the sub-steps. Only action and AI steps are supported in parallel
  // (ctx.run calls return RestatePromise; awakeables cannot be mixed).
  const parallelPromises: restate.RestatePromise<unknown>[] = [];

  for (const stepId of step.steps) {
    const idx = stepIndex.get(stepId);
    if (idx === undefined) {
      throw new restate.TerminalError(`Parallel sub-step "${stepId}" not found`);
    }
    const subStep = steps[idx];
    if (!subStep) {
      throw new restate.TerminalError(`Parallel sub-step "${stepId}" not found at index ${idx}`);
    }

    if (subStep.type === "action") {
      const resolvedInput = resolveExpression((subStep as ActionFlowStep).input, flowCtx);
      parallelPromises.push(
        ctx.run(subStep.id, () =>
          stepContext.executeAction((subStep as ActionFlowStep).actionName, resolvedInput),
        ),
      );
    } else if (subStep.type === "ai") {
      const aiStep = subStep as AIFlowStep;
      const prompt = resolvePrompt(aiStep.prompt, flowCtx);
      parallelPromises.push(
        ctx.run(subStep.id, () =>
          stepContext.callAI({
            prompt,
            model: aiStep.model,
            tools: aiStep.tools,
            responseFormat: aiStep.responseFormat,
          }),
        ),
      );
    } else {
      throw new restate.TerminalError(
        `Parallel sub-step "${stepId}" has unsupported type "${subStep.type}". ` +
          "Only action and ai steps can run in parallel.",
      );
    }
  }

  // Use the appropriate combinator
  if (step.joinType === "any") {
    const winner = await restate.RestatePromise.any(parallelPromises);
    // Store winner output under the parallel step ID
    return winner;
  }

  const results = await restate.RestatePromise.all(parallelPromises);
  // Store individual sub-step outputs in flow context
  for (let i = 0; i < step.steps.length; i++) {
    const sid = step.steps[i];
    if (sid) flowCtx.steps[sid] = { output: results[i] };
  }
  return results;
}
