/**
 * Command Layer — slot-based middleware pipeline.
 *
 * All entry points (HTTP / MCP / CLI / UI) go through the same pipeline.
 * Capabilities fill slots by registering middlewares (e.g. cap-auth fills "auth").
 * Unfilled slots are automatically skipped — except permission: when no permission
 * middleware is registered, the executor's built-in permission check still runs (fail-closed).
 *
 * Pipeline order: pre → auth → exposure → permission → tenant → pre-action → [action] → post-action
 *
 * Action execution is placed inside the compose chain so that any middleware not calling
 * next() will block the action from running.
 *
 * See spec 16_command_layer_and_api.md §2.2 and 20_extension_mechanism.md §8.
 */

import { AuthorizationError, LinchKitError, SystemError } from "../errors";
import { consoleLogger } from "../observability/console-logger";
import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import { getCurrentTrace, withTrace } from "../observability/trace-context";
import type { ActionDefinition, ActionResult, Actor } from "../types/action";
import type { Logger } from "../types/logger";
import type { ActionExecutor, ExecuteOptions, ExecutionChannel } from "./action-engine";

// ── Slot names (execution order) ────────────────────────────

const SLOT_ORDER = [
  "pre",
  "auth",
  "exposure",
  "permission",
  "tenant",
  "pre-action",
  "post-action",
] as const;

export type SlotName = (typeof SLOT_ORDER)[number];

// ── Pipeline ID generator ───────────────────────────────────

function generatePipelineId(): string {
  return `pipeline_${crypto.randomUUID()}`;
}

// ── CommandContext ───────────────────────────────────────────

export interface CommandContext {
  /** Action name to execute */
  command: string;
  /** Action input (unwrapped body) */
  input: Record<string, unknown>;
  /** Entry channel */
  channel: ExecutionChannel;
  /** Current actor — auth middleware fills this */
  actor: Actor;
  /** Tenant ID — tenant middleware fills this */
  tenantId?: string;
  /** Locale for translatable field resolution */
  locale?: string;
  /** HTTP headers (when channel is http) */
  headers?: Record<string, string>;
  /** Arbitrary extension data for middleware communication */
  meta: Record<string, unknown>;
  /** The resolved action definition (set by pipeline before exposure check) */
  action?: ActionDefinition;
  /** Action execution result (set after action runs, available in post-action) */
  result?: ActionResult;
  /** Trace ID — set automatically by the pipeline for observability */
  traceId?: string;
}

// ── Middleware types ────────────────────────────────────────

export type MiddlewareHandler = (ctx: CommandContext, next: () => Promise<void>) => Promise<void>;

export interface MiddlewareRegistration {
  /** Unique middleware name */
  name: string;
  /** Which slot to fill */
  slot: SlotName;
  /** Sort order within slot — smaller runs first (default: 100) */
  order?: number;
  /** Koa-style handler */
  handler: MiddlewareHandler;
  /** If true, post-action failure is surfaced as a warning on the result */
  critical?: boolean;
}

// ── Anonymous actor default ─────────────────────────────────

const ANONYMOUS_ACTOR: Actor = {
  type: "system",
  id: "anonymous",
  groups: [],
};

// ── Exposure check (built-in) ───────────────────────────────

function checkExposure(action: ActionDefinition, channel: ExecutionChannel): boolean {
  const exposure = action.exposure;
  if (exposure === undefined || exposure === "all") return true;
  const val = exposure[channel];
  return val !== false;
}

// ── CommandLayer ────────────────────────────────────────────

export interface CommandLayerOptions {
  /** The action executor to invoke after pipeline */
  executor: ActionExecutor;
  /** Optional structured logger (defaults to consoleLogger) */
  logger?: Logger;
  /**
   * Verify that an approvalId is valid and approved.
   * Called when approvalId is provided in execute options.
   * If not configured, approvalId is ignored (fail-closed — security slots are NOT skipped).
   */
  verifyApproval?: (approvalId: string) => Promise<boolean>;
  /** Metrics collector — optional, defaults to noopMetricsCollector (zero overhead) */
  metrics?: MetricsCollector;
}

export interface CommandLayer {
  /** Register a middleware into a slot */
  use(registration: MiddlewareRegistration): void;
  /** Execute the full pipeline for a command */
  execute(options: CommandExecuteOptions): Promise<ActionResult>;
  /** Get all registered middlewares (for introspection) */
  getMiddlewares(): MiddlewareRegistration[];
}

export interface CommandExecuteOptions {
  command: string;
  input: Record<string, unknown>;
  channel?: ExecutionChannel;
  actor?: Actor;
  headers?: Record<string, string>;
  tenantId?: string;
  /** Locale for translatable field resolution */
  locale?: string;
  meta?: Record<string, unknown>;
  /**
   * When set, this is an approval re-execution. The pipeline will:
   * - SKIP auth, exposure, permission slots (already checked on original submission)
   * - RUN pre, tenant, pre-action, post-action slots
   */
  approvalId?: string;
  /** Rule names to skip during re-execution (forwarded to executor) */
  skipRules?: string[];
}

/**
 * Create a CommandLayer instance.
 *
 * Usage:
 * ```ts
 * const layer = createCommandLayer({ executor });
 * layer.use({ name: 'jwt_auth', slot: 'auth', handler: async (ctx, next) => { ... } });
 * const result = await layer.execute({ command: 'submit_request', input: { id: 'pr_001' } });
 * ```
 */
export function createCommandLayer(options: CommandLayerOptions): CommandLayer {
  const {
    executor,
    logger = consoleLogger,
    verifyApproval,
    metrics = noopMetricsCollector,
  } = options;
  const middlewares: MiddlewareRegistration[] = [];

  function use(registration: MiddlewareRegistration): void {
    // Validate slot name
    if (!SLOT_ORDER.includes(registration.slot)) {
      throw new Error(`Invalid slot name: "${registration.slot}"`);
    }
    // Disallow registering into "exposure" slot (built-in only)
    if (registration.slot === "exposure") {
      throw new Error('Cannot register middleware into "exposure" slot — it is built-in');
    }
    // Check duplicate name
    if (middlewares.some((m) => m.name === registration.name)) {
      throw new Error(`Middleware "${registration.name}" is already registered`);
    }
    middlewares.push(registration);
  }

  function getMiddlewares(): MiddlewareRegistration[] {
    return [...middlewares];
  }

  /** Get sorted middlewares for a given slot */
  function getSlotMiddlewares(slot: SlotName): MiddlewareRegistration[] {
    return middlewares
      .filter((m) => m.slot === slot)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** Compose middlewares into a single function (Koa-style) */
  function compose(
    handlers: Array<(ctx: CommandContext, next: () => Promise<void>) => Promise<void>>,
  ): (ctx: CommandContext) => Promise<void> {
    return async (ctx: CommandContext) => {
      let index = -1;

      async function dispatch(i: number): Promise<void> {
        if (i <= index) {
          throw new Error("next() called multiple times");
        }
        index = i;
        const handler = handlers[i];
        if (!handler) return;
        await handler(ctx, () => dispatch(i + 1));
      }

      await dispatch(0);
    };
  }

  async function execute(execOptions: CommandExecuteOptions): Promise<ActionResult> {
    // Wrap entire pipeline in a trace context for observability.
    // If already inside a trace (e.g. event handler re-entry), depth increments.
    const pipelineStart = Date.now();
    return (await withTrace(async () => {
      return await executeInner(execOptions, pipelineStart);
    })) as ActionResult;
  }

  async function executeInner(
    execOptions: CommandExecuteOptions,
    pipelineStart: number,
  ): Promise<ActionResult> {
    // Capture trace ID from the active trace context
    const trace = getCurrentTrace();

    // Build context with copies to isolate from caller
    const ctx: CommandContext = {
      command: execOptions.command,
      input: { ...execOptions.input },
      channel: execOptions.channel ?? "internal",
      actor: execOptions.actor
        ? { ...execOptions.actor, groups: [...execOptions.actor.groups] }
        : { ...ANONYMOUS_ACTOR, groups: [...ANONYMOUS_ACTOR.groups] },
      tenantId: execOptions.tenantId,
      locale: execOptions.locale,
      headers: execOptions.headers ? { ...execOptions.headers } : undefined,
      meta: { ...(execOptions.meta ?? {}) },
      traceId: trace?.traceId,
    };

    // Resolve action definition for exposure check
    const action = executor.registry.get(ctx.command);
    if (!action) {
      return {
        success: false,
        data: { error: `Action "${ctx.command}" not found` },
        executionId: generatePipelineId(),
      };
    }
    ctx.action = action;

    // Determine if permission middleware is registered (#1 — fail-closed)
    const hasPermissionMiddleware = getSlotMiddlewares("permission").length > 0;

    // Approval re-execution: skip auth, exposure, permission slots ONLY when
    // a verifyApproval callback is configured AND it confirms the approvalId is valid.
    // Fail-closed: without verifyApproval, approvalId is ignored and all slots run.
    let isApprovalReExecution = false;
    if (execOptions.approvalId) {
      if (!verifyApproval) {
        // No verification function configured — fail-closed, do NOT skip security slots
        logger.warn(
          `[CommandLayer] approvalId provided but no verifyApproval configured — ignoring (fail-closed)`,
        );
      } else {
        const isValid = await verifyApproval(execOptions.approvalId);
        if (!isValid) {
          return {
            success: false,
            data: { error: "Invalid or unapproved approvalId", code: "APPROVAL.INVALID" },
            executionId: generatePipelineId(),
          };
        }
        isApprovalReExecution = true;
      }
    }
    const skippedSlots: Set<SlotName> = isApprovalReExecution
      ? new Set(["auth", "exposure", "permission"])
      : new Set();

    // Build the pipeline: collect handlers from each slot in order
    const pipeline: Array<(ctx: CommandContext, next: () => Promise<void>) => Promise<void>> = [];

    for (const slot of SLOT_ORDER) {
      // Skip slots that are not needed for approval re-execution
      if (skippedSlots.has(slot)) {
        continue;
      }

      if (slot === "exposure") {
        // Built-in exposure check
        pipeline.push(async (c, next) => {
          if (!checkExposure(action, c.channel)) {
            throw new ExposureError(
              `Action "${c.command}" is not exposed for channel "${c.channel}"`,
            );
          }
          await next();
        });
      } else if (slot === "post-action") {
        // Handled separately after action execution
      } else {
        const slotMiddlewares = getSlotMiddlewares(slot);
        for (const mw of slotMiddlewares) {
          pipeline.push(mw.handler);
        }
      }
    }

    // Build executor options, forwarding approval-related fields when present
    const executorOptions: ExecuteOptions = {
      channel: ctx.channel,
      skipExposureCheck: true, // Always handled by pipeline built-in slot
      skipPermissionCheck: isApprovalReExecution || hasPermissionMiddleware,
      tenantId: ctx.tenantId,
      locale: ctx.locale,
    };
    if (execOptions.approvalId) {
      executorOptions.approvalId = execOptions.approvalId;
    }
    if (execOptions.skipRules) {
      executorOptions.skipRules = execOptions.skipRules;
    }

    // Action execution as the innermost handler in the compose chain (#2).
    // If any middleware does not call next(), the action will NOT run.
    // Use `action.name` (resolved before pipeline) instead of `c.command` to prevent
    // middleware from swapping the command after exposure/permission checks ran.
    pipeline.push(async (c: CommandContext, _next: () => Promise<void>) => {
      try {
        const result = await executor.execute(action.name, c.input, c.actor, {
          ...executorOptions,
          tenantId: c.tenantId, // Use latest tenantId (tenant middleware may have set it)
          locale: c.locale, // Use latest locale (middleware may have set it)
        });
        c.result = result;
      } catch (_err) {
        // Executor should return ActionResult, but guard against unexpected throws (#4)
        c.result = {
          success: false,
          data: { error: "Action execution failed" },
          executionId: generatePipelineId(),
        };
      }
    });

    // Execute the full pipeline (pre → auth → exposure → permission → tenant → pre-action → action)
    try {
      const run = compose(pipeline);
      await run(ctx);
    } catch (err) {
      metrics.increment("command.processed", { command: ctx.command, status: "failed" });
      metrics.timing("command.duration_ms", Date.now() - pipelineStart, {
        command: ctx.command,
      });
      if (err instanceof ExposureError) {
        return {
          success: false,
          data: { error: err.message },
          executionId: generatePipelineId(),
        };
      }
      if (err instanceof PipelineError) {
        return {
          success: false,
          data: { error: err.message, code: err.pipelineCode },
          executionId: generatePipelineId(),
        };
      }
      if (err instanceof LinchKitError) {
        return {
          success: false,
          data: { error: err.message, code: err.code, details: err.details },
          executionId: generatePipelineId(),
        };
      }
      // Unknown error — sanitize to prevent information leakage (#3)
      return {
        success: false,
        data: { error: "Internal pipeline error" },
        executionId: generatePipelineId(),
      };
    }

    // If action didn't execute (middleware blocked by not calling next())
    if (!ctx.result) {
      metrics.increment("command.processed", { command: ctx.command, status: "blocked" });
      metrics.timing("command.duration_ms", Date.now() - pipelineStart, {
        command: ctx.command,
      });
      return {
        success: false,
        data: { error: "Request blocked by pipeline" },
        executionId: generatePipelineId(),
      };
    }

    // Run post-action middlewares individually to track critical failures
    const postMiddlewares = getSlotMiddlewares("post-action");
    if (postMiddlewares.length > 0) {
      for (const mw of postMiddlewares) {
        try {
          await mw.handler(ctx, async () => {});
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (mw.critical) {
            // Critical post-action failure: log as error and add warning to result
            logger.error(
              `[CommandLayer] critical post-action middleware "${mw.name}" failed (action=${ctx.command}): ${errorMsg}`,
            );
            if (ctx.result) {
              // biome-ignore lint/suspicious/noExplicitAny: ActionResult shape varies
              const warnings = ((ctx.result as any).warnings as string[]) ?? [];
              warnings.push(`Post-action "${mw.name}" failed: ${errorMsg}`);
              // biome-ignore lint/suspicious/noExplicitAny: ActionResult shape varies
              (ctx.result as any).warnings = warnings;
            }
          } else {
            // Non-critical: log warn and continue
            logger.warn(
              `[CommandLayer] post-action middleware "${mw.name}" error (action=${ctx.command}): ${errorMsg}`,
            );
          }
        }
      }
    }

    metrics.increment("command.processed", { command: ctx.command, status: "succeeded" });
    metrics.timing("command.duration_ms", Date.now() - pipelineStart, {
      command: ctx.command,
    });

    return ctx.result;
  }

  return { use, execute, getMiddlewares };
}

// ── Pipeline errors ─────────────────────────────────────────

/** Error thrown by built-in exposure check */
export class ExposureError extends AuthorizationError {
  constructor(message: string) {
    super({ message, code: "command.exposure.denied" });
    this.name = "ExposureError";
  }
}

/** Error thrown by middleware to short-circuit the pipeline with a code */
export class PipelineError extends SystemError {
  /** Pipeline-specific error code (e.g. "AUTH.REQUIRED", "PERMISSION.DENIED") */
  readonly pipelineCode: string;

  constructor(message: string, code: string) {
    super({ message, code: "command.pipeline.error" });
    this.pipelineCode = code;
    this.name = "PipelineError";
  }
}
