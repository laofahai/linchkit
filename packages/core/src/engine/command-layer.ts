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

import type { ActionDefinition, ActionResult, Actor } from "../types/action";
import type { Logger } from "../types/logger";
import type { ActionExecutor, ExecutionChannel } from "./action-engine";
import { consoleLogger } from "./console-logger";

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

let pipelineCounter = 0;

function generatePipelineId(): string {
  pipelineCounter++;
  return `pipeline_${Date.now()}_${pipelineCounter}`;
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
  /** HTTP headers (when channel is http) */
  headers?: Record<string, string>;
  /** Arbitrary extension data for middleware communication */
  meta: Record<string, unknown>;
  /** The resolved action definition (set by pipeline before exposure check) */
  action?: ActionDefinition;
  /** Action execution result (set after action runs, available in post-action) */
  result?: ActionResult;
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
  meta?: Record<string, unknown>;
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
  const { executor, logger = consoleLogger } = options;
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
    // Build context with copies to isolate from caller
    const ctx: CommandContext = {
      command: execOptions.command,
      input: { ...execOptions.input },
      channel: execOptions.channel ?? "internal",
      actor: execOptions.actor
        ? { ...execOptions.actor, groups: [...execOptions.actor.groups] }
        : { ...ANONYMOUS_ACTOR, groups: [...ANONYMOUS_ACTOR.groups] },
      tenantId: execOptions.tenantId,
      headers: execOptions.headers ? { ...execOptions.headers } : undefined,
      meta: { ...(execOptions.meta ?? {}) },
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

    // Build the pipeline: collect handlers from each slot in order
    const pipeline: Array<(ctx: CommandContext, next: () => Promise<void>) => Promise<void>> = [];

    for (const slot of SLOT_ORDER) {
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

    // Action execution as the innermost handler in the compose chain (#2).
    // If any middleware does not call next(), the action will NOT run.
    // Use `action.name` (resolved before pipeline) instead of `c.command` to prevent
    // middleware from swapping the command after exposure/permission checks ran.
    pipeline.push(async (c: CommandContext, _next: () => Promise<void>) => {
      try {
        const result = await executor.execute(action.name, c.input, c.actor, {
          channel: c.channel,
          skipExposureCheck: true, // Always handled by pipeline built-in slot
          skipPermissionCheck: hasPermissionMiddleware, // Only skip if pipeline handled it
          tenantId: c.tenantId,
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
          data: { error: err.message, code: err.code },
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
      return {
        success: false,
        data: { error: "Request blocked by pipeline" },
        executionId: generatePipelineId(),
      };
    }

    // Run post-action middlewares
    const postMiddlewares = getSlotMiddlewares("post-action");
    if (postMiddlewares.length > 0) {
      try {
        const runPost = compose(postMiddlewares.map((m) => m.handler));
        await runPost(ctx);
      } catch (err) {
        // Post-action errors don't affect the action result (#5)
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[CommandLayer] post-action middleware error (action=${ctx.command}): ${errorMsg}`,
        );
      }
    }

    return ctx.result;
  }

  return { use, execute, getMiddlewares };
}

// ── Pipeline errors ─────────────────────────────────────────

/** Error thrown by built-in exposure check */
export class ExposureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposureError";
  }
}

/** Error thrown by middleware to short-circuit the pipeline with a code */
export class PipelineError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
  }
}
