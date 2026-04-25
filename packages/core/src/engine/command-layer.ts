/**
 * Command Layer — slot-based middleware pipeline.
 *
 * All entry points (HTTP / MCP / CLI / UI) go through the same pipeline.
 * Capabilities fill slots by registering middlewares (e.g. cap-auth fills "auth").
 * Unfilled slots are automatically skipped — except permission: for normal
 * action dispatch, if no permission middleware is registered, the executor's
 * built-in permission check still runs (fail-closed). For non-action dispatch
 * (`skipActionSlots: true`), the executor is never invoked, so an empty
 * permission slot is rejected explicitly with `PERMISSION.MIDDLEWARE_MISSING`.
 *
 * Pipeline order: pre → auth → exposure → permission → tenant → pre-action → [action] → post-action
 *
 * Action execution is placed inside the compose chain so that any middleware not calling
 * next() will block the action from running.
 *
 * Non-action dispatches (`CommandExecuteOptions.skipActionSlots = true`): used by the
 * entity onchange endpoint (Spec 64 §4.3). The pipeline runs pre / auth / permission /
 * tenant but skips exposure / pre-action / post-action and does not invoke the
 * ActionExecutor; a synthetic success result is returned so downstream code can
 * produce the actual response payload. Requires a registered permission middleware
 * (see guard above). Cannot be combined with `approvalId` — the combination would
 * silently drop auth+permission and is rejected with `COMMAND.INVALID_OPTIONS`.
 *
 * See spec 16_command_layer_and_api.md §2.2 and 20_extension_mechanism.md §8.
 */

import { AuthorizationError, LinchKitError, SystemError } from "../errors";
import { consoleLogger } from "../observability/console-logger";
import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import { getCurrentTrace, withTrace, withTraceId } from "../observability/trace-context";
import type { ActionDefinition, ActionResult, Actor } from "../types/action";
import type { BatchActionsInput, BatchActionsResult, BatchSucceededItem } from "../types/batch";
import type { Logger } from "../types/logger";
import type {
  ActionExecutor,
  DataProvider,
  ExecuteOptions,
  ExecutionChannel,
  PendingEvent,
  TransactionManager,
} from "./action-engine";
import { generateExecutionId } from "./action-helpers";
import { MAX_BATCH_SIZE } from "./batch-action-engine";

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
  /**
   * Default transaction manager used by `executeBatch` when the strategy is
   * `all_or_nothing` and the per-call options omit `transactionManager`. Wire
   * this from the same instance you pass to `createActionExecutor` so REST /
   * MCP / CLI callers all get transactional batch semantics for free. A
   * per-call `options.transactionManager` still wins when supplied.
   */
  transactionManager?: TransactionManager;
}

export interface CommandLayer {
  /** Register a middleware into a slot */
  use(registration: MiddlewareRegistration): void;
  /** Execute the full pipeline for a command */
  execute(options: CommandExecuteOptions): Promise<ActionResult>;
  /**
   * Execute a batch of actions through the full pipeline (Spec 04 §8,
   * Spec 16 §2.1). Each item runs the same pipeline as `execute()`; for
   * `all_or_nothing` strategy a single shared DB transaction wraps all
   * items so any failure rolls back every prior write.
   */
  executeBatch(options: CommandBatchExecuteOptions): Promise<BatchActionsResult>;
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
  /** External trace ID — when provided, the pipeline reuses this instead of generating a new one */
  traceId?: string;
  /**
   * Include soft-deleted records when the action reads the target row.
   * Used by `restore_*` actions so they can locate the row before writing.
   * Forwarded to the executor; the permission slot still runs — callers must
   * be authorized to read/restore the deleted row.
   */
  includeDeleted?: boolean;
  /**
   * Non-action dispatch mode (Spec 64 §4.3). When true, the pipeline:
   * - RUNS pre, auth, permission, tenant slots
   * - SKIPS exposure (no action to expose), pre-action and post-action slots
   * - SKIPS action execution (returns a synthetic success result with `data.skipped = true`)
   *
   * Post-action is deliberately skipped: notification, cache-invalidation and
   * event-fan-out middlewares run after write side effects — a non-action
   * dispatch has no writes so firing them would be semantically wrong.
   *
   * Used by endpoints that need to pass through the CommandLayer for
   * auth/permission/tenant enforcement WITHOUT executing a write action —
   * currently the entity onchange endpoint (interactive form computation).
   *
   * ### `meta.onchange` contract (for permission middleware)
   *
   * Callers MUST populate `meta.onchange = { entity, changedField }` so the
   * permission slot can perform an entity-level READ check instead of looking
   * up an action. The synthetic command name is typically
   * `"<entityName>.onchange"` and is intended for metrics/tracing only —
   * permission middleware should NOT match on `ctx.action` or on the command
   * name when `meta.onchange` is present.
   *
   * Example (permission middleware):
   * ```ts
   * if (ctx.meta.onchange) {
   *   const { entity } = ctx.meta.onchange as { entity: string };
   *   assertCanRead(ctx.actor, entity);
   * }
   * ```
   */
  skipActionSlots?: boolean;
  /**
   * Internal: shared transactional data provider injected by
   * `CommandLayer.executeBatch` when running the `all_or_nothing` strategy.
   * Forwarded to the executor so every batch item participates in the
   * outer transaction. Public callers MUST NOT set this — it is reserved
   * for the batch pipeline.
   */
  _txDataProvider?: DataProvider;
  /**
   * Internal: shared pending-events array for the batch transaction.
   * Forwarded to the executor so child events accumulate in the parent's
   * outbox. See `_txDataProvider`.
   */
  _parentPendingEvents?: PendingEvent[];
}

// ── Batch execute options ───────────────────────────────────

/** Options for {@link CommandLayer.executeBatch}. */
export interface CommandBatchExecuteOptions {
  /** Batch payload (`actions`, optional `strategy`). */
  input: BatchActionsInput;
  /** Channel — propagated to every item (default: `internal`). */
  channel?: ExecutionChannel;
  /** Caller actor — propagated to every item. */
  actor?: Actor;
  /** HTTP headers — propagated to every item (when channel is http). */
  headers?: Record<string, string>;
  /** Tenant ID — propagated to every item. */
  tenantId?: string;
  /** Locale — propagated to every item. */
  locale?: string;
  /** Caller meta — merged with batch tracking keys per item. */
  meta?: Record<string, unknown>;
  /**
   * Transaction manager used by `all_or_nothing`. When omitted, falls back
   * to the `transactionManager` configured on `createCommandLayer`. If
   * neither is provided and the strategy is `all_or_nothing`, the call
   * returns a structured `BATCH_TX_MANAGER_REQUIRED` failure.
   */
  transactionManager?: TransactionManager;
  /** External trace ID — when provided, the pipeline reuses it. */
  traceId?: string;
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
    transactionManager: defaultTransactionManager,
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
    const traceFn = async () => executeInner(execOptions, pipelineStart);
    if (execOptions.traceId) {
      return (await withTraceId(execOptions.traceId, traceFn)) as ActionResult;
    }
    return (await withTrace(traceFn)) as ActionResult;
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

    const skipActionSlots = execOptions.skipActionSlots === true;

    // Resolve action definition for exposure check (only when an action will run)
    let action: ActionDefinition | undefined;
    if (!skipActionSlots) {
      action = executor.registry.get(ctx.command);
      if (!action) {
        return {
          success: false,
          data: { error: `Action "${ctx.command}" not found` },
          executionId: generatePipelineId(),
        };
      }
      ctx.action = action;
    }

    // Determine if permission middleware is registered (#1 — fail-closed).
    // Use `.some()` rather than `getSlotMiddlewares().length > 0` to avoid
    // filtering+sorting the middleware array on every request.
    const hasPermissionMiddleware = middlewares.some((m) => m.slot === "permission");

    // Fail-closed guard: non-action dispatch (`skipActionSlots`) bypasses the
    // ActionExecutor entirely, so the executor's built-in permission check —
    // documented at the top of this file as the fallback when no permission
    // middleware is registered — never fires. Without a registered permission
    // middleware, an onchange-style request would run with zero authorization.
    // Reject the request explicitly instead of silently running unguarded.
    if (skipActionSlots && !hasPermissionMiddleware) {
      return {
        success: false,
        data: {
          error:
            "Non-action dispatch (skipActionSlots) requires a permission middleware — built-in executor fallback does not apply.",
          code: "PERMISSION.MIDDLEWARE_MISSING",
        },
        executionId: generatePipelineId(),
      };
    }

    // Reject the `approvalId` + `skipActionSlots` combination. Approval
    // re-execution skips {auth, exposure, permission}; non-action dispatch
    // skips {exposure, pre-action, post-action}. Combined, auth AND permission
    // would silently drop — contradicting the `skipActionSlots` contract that
    // auth/permission/tenant still run. No legitimate flow needs this pair.
    if (execOptions.approvalId && skipActionSlots) {
      return {
        success: false,
        data: {
          error: "approvalId is not supported with skipActionSlots.",
          code: "COMMAND.INVALID_OPTIONS",
        },
        executionId: generatePipelineId(),
      };
    }

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
    // Non-action dispatch: skip exposure + pre-action + post-action slots.
    // The exposure slot has nothing to check (no action); pre/post-action hooks
    // only apply to write actions. Auth / permission / tenant still run.
    if (skipActionSlots) {
      skippedSlots.add("exposure");
      skippedSlots.add("pre-action");
      skippedSlots.add("post-action");
    }

    // Build the pipeline: collect handlers from each slot in order
    const pipeline: Array<(ctx: CommandContext, next: () => Promise<void>) => Promise<void>> = [];

    for (const slot of SLOT_ORDER) {
      // Skip slots that are not needed for approval re-execution
      if (skippedSlots.has(slot)) {
        continue;
      }

      if (slot === "exposure") {
        // Built-in exposure check — only applicable when an action is resolved.
        if (action) {
          const resolvedAction = action;
          pipeline.push(async (c, next) => {
            if (!checkExposure(resolvedAction, c.channel)) {
              throw new ExposureError(
                `Action "${c.command}" is not exposed for channel "${c.channel}"`,
              );
            }
            await next();
          });
        }
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
    if (execOptions.includeDeleted) {
      executorOptions.includeDeleted = execOptions.includeDeleted;
    }
    // Internal batch plumbing: forward shared transaction context when set
    // by `executeBatch`. Public callers do not set these (see
    // CommandExecuteOptions docs); the pipeline still runs every slot for
    // each item, so security guarantees match a single-action call.
    if (execOptions._txDataProvider) {
      executorOptions._txDataProvider = execOptions._txDataProvider;
    }
    if (execOptions._parentPendingEvents) {
      executorOptions._parentPendingEvents = execOptions._parentPendingEvents;
    }

    // Action execution as the innermost handler in the compose chain (#2).
    // If any middleware does not call next(), the action will NOT run.
    // Use `action.name` (resolved before pipeline) instead of `c.command` to prevent
    // middleware from swapping the command after exposure/permission checks ran.
    if (action && !skipActionSlots) {
      const resolvedAction = action;
      pipeline.push(async (c: CommandContext, _next: () => Promise<void>) => {
        // Pass `c.meta` through as a plain record and let ActionEngine be the
        // single source of truth for meta normalization (strip _-prefix,
        // filter non-serializable, enforce 8 KB including `_execution_id`).
        // Any middleware that mutated `c.meta` for pipeline-internal state
        // still feeds the final handler-visible meta via this handoff —
        // Spec 65 §8.3.
        //
        // TODO(spec-65 Phase 2): The execution-log writer should record
        // `meta.toJSON()` alongside the existing ExecutionLogEntry fields.
        try {
          const result = await executor.execute(resolvedAction.name, c.input, c.actor, {
            ...executorOptions,
            tenantId: c.tenantId, // Use latest tenantId (tenant middleware may have set it)
            locale: c.locale, // Use latest locale (middleware may have set it)
            meta: c.meta,
          });
          c.result = result;
          // ActionEngine rejected the meta (oversized after all system keys
          // applied). The action handler never ran → post-action hooks
          // (cache invalidation, event fan-out, notifications) are
          // write-side semantics and MUST NOT fire. Mirror the
          // `skipActionSlots` contract by skipping post-action here.
          const code = (result.data as { code?: unknown } | undefined)?.code;
          if (!result.success && code === "META.SIZE_EXCEEDED") {
            skippedSlots.add("post-action");
          }
        } catch (_err) {
          // Executor should return ActionResult, but guard against unexpected throws (#4)
          c.result = {
            success: false,
            data: { error: "Action execution failed" },
            executionId: generatePipelineId(),
          };
        }
      });
    } else {
      // Non-action dispatch: set a synthetic success result so downstream code
      // knows the pipeline completed without error. The caller is responsible
      // for producing the actual response payload (e.g. onchange updates).
      // Include the resolved actor / tenantId / locale (read from the final
      // ctx after middleware runs) so downstream handlers like the onchange
      // REST/GraphQL routes can propagate them without having to re-derive
      // from the request — auth middleware that enriches/replaces the actor
      // (role hydration, impersonation) MUST be honored here, otherwise
      // OnchangeContext.actor would diverge from the pipeline-resolved
      // identity. (Spec 64 §9.1 — onchange runs with caller's permissions.)
      pipeline.push(async (c: CommandContext, _next: () => Promise<void>) => {
        c.result = {
          success: true,
          data: {
            skipped: true,
            actor: c.actor,
            tenantId: c.tenantId,
            locale: c.locale,
          },
          executionId: generatePipelineId(),
        };
      });
    }

    // Execute the full pipeline (pre → auth → exposure → permission → tenant → pre-action → action)
    try {
      const run = compose(pipeline);
      await run(ctx);
    } catch (err) {
      metrics.increment("action.executions", { action: ctx.command, status: "error" });
      metrics.increment("action.errors", { action: ctx.command });
      metrics.timing("action.duration_ms", Date.now() - pipelineStart, {
        action: ctx.command,
      });
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
      metrics.increment("action.executions", { action: ctx.command, status: "blocked" });
      metrics.timing("action.duration_ms", Date.now() - pipelineStart, {
        action: ctx.command,
      });
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

    // Run post-action middlewares individually to track critical failures.
    // Non-action dispatches (`skipActionSlots = true`, e.g. onchange) must NOT
    // trigger post-action side effects — cache invalidation, event fan-out and
    // notifications are only correct after a real write. Honor the same
    // `skippedSlots` set the pre/post pipeline uses to stay consistent.
    const postMiddlewares = skippedSlots.has("post-action")
      ? []
      : getSlotMiddlewares("post-action");
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

    const actionStatus = ctx.result.success ? "success" : "error";
    metrics.increment("action.executions", { action: ctx.command, status: actionStatus });
    if (!ctx.result.success) {
      metrics.increment("action.errors", { action: ctx.command });
    }
    metrics.timing("action.duration_ms", Date.now() - pipelineStart, {
      action: ctx.command,
    });

    metrics.increment("command.processed", { command: ctx.command, status: "succeeded" });
    metrics.timing("command.duration_ms", Date.now() - pipelineStart, {
      command: ctx.command,
    });

    return ctx.result;
  }

  /**
   * Execute a batch of actions. v1 implementation chooses the simpler
   * "execute()-per-item" fallback over a per-slot refactor:
   *
   *   - Each item runs the full pipeline (auth/exposure/permission/tenant/
   *     pre-action/post-action) by reusing `executeInner` directly. This
   *     means auth and tenant slots run once per item rather than once per
   *     batch — acceptable trade-off for batch sizes ≤ MAX_BATCH_SIZE
   *     (500), since the auth slot caches actor lookups and tenant slot
   *     work is cheap.
   *   - For `all_or_nothing`, we open one outer transaction and inject
   *     `_txDataProvider` + `_parentPendingEvents` into each item's
   *     pipeline. The executor's existing shared-tx seam (action-engine.ts
   *     `parentTxProvider` branch) honors this and skips opening a nested
   *     transaction.
   *
   * Trade-off justification: a slot-level refactor would split the pipeline
   * into "once per batch" (auth/tenant) + "once per item" (exposure/
   * permission/pre-action/post-action). That's a bigger refactor of
   * existing code with no observable behavior difference at batch size
   * ≤ 500. Defer until real benchmarks show auth/tenant overhead matters.
   */
  async function executeBatch(options: CommandBatchExecuteOptions): Promise<BatchActionsResult> {
    const strategy = options.input.strategy ?? "all_or_nothing";
    const items = options.input.actions;
    const parentExecutionId = generateExecutionId();
    // Generate one shared trace ID per batch when the caller doesn't supply
    // one, so all child executions correlate in observability tools.
    const batchTraceId = options.traceId ?? generateExecutionId();

    // Input validation — same rules as executeBatch in batch-action-engine.
    if (!Array.isArray(items) || items.length === 0) {
      return buildBatchValidationFailure(
        parentExecutionId,
        strategy,
        "BATCH_EMPTY",
        "Batch must contain at least one action.",
      );
    }
    if (items.length > MAX_BATCH_SIZE) {
      return buildBatchValidationFailure(
        parentExecutionId,
        strategy,
        "BATCH_TOO_LARGE",
        `Batch size ${items.length} exceeds the maximum of ${MAX_BATCH_SIZE}.`,
      );
    }

    const effectiveTxManager = options.transactionManager ?? defaultTransactionManager;
    if (strategy === "all_or_nothing" && !effectiveTxManager) {
      return buildBatchValidationFailure(
        parentExecutionId,
        strategy,
        "BATCH_TX_MANAGER_REQUIRED",
        "all_or_nothing strategy requires a TransactionManager. Pass one via createCommandLayer's options.transactionManager or per-call options.transactionManager, or use strategy: 'partial'.",
      );
    }

    const baseChannel = options.channel ?? "internal";

    // Build per-item options once — we vary only the per-item meta + tx fields.
    const buildItemOptions = (
      index: number,
      item: { name: string; input: Record<string, unknown> },
      tx?: { provider: DataProvider; events: PendingEvent[] },
    ): CommandExecuteOptions => {
      // Use non-underscore keys so the action engine's system-key strip
      // (Spec 65 §4.4) doesn't drop batch tracking keys at root depth.
      // Place batch keys AFTER caller meta so they overwrite — these are
      // framework-owned and a caller must not be able to clobber them.
      const itemMeta: Record<string, unknown> = {
        ...(options.meta ?? {}),
        "batch.parentExecutionId": parentExecutionId,
        "batch.index": index,
      };
      const opts: CommandExecuteOptions = {
        command: item.name,
        input: item.input,
        channel: baseChannel,
        actor: options.actor,
        headers: options.headers,
        tenantId: options.tenantId,
        locale: options.locale,
        meta: itemMeta,
      };
      opts.traceId = batchTraceId;
      if (tx) {
        opts._txDataProvider = tx.provider;
        opts._parentPendingEvents = tx.events;
      }
      return opts;
    };

    // ── Strategy: partial ─────────────────────────────────
    if (strategy === "partial") {
      const succeeded: BatchSucceededItem[] = [];
      const failed: BatchActionsResult["failed"] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const result = await execute(buildItemOptions(i, item));
        if (result.success) {
          succeeded.push(toSucceededItem(i, result));
        } else {
          failed.push({
            index: i,
            executionId: result.executionId,
            error: extractErrorFromActionResult(result),
          });
        }
      }

      return {
        success: failed.length === 0,
        parentExecutionId,
        strategy: "partial",
        succeeded,
        failed,
        summary: {
          total: items.length,
          succeeded: succeeded.length,
          failed: failed.length,
        },
      };
    }

    // ── Strategy: all_or_nothing ──────────────────────────
    const txManager = effectiveTxManager as TransactionManager;
    const sharedPendingEvents: PendingEvent[] = [];
    const succeededInside: BatchSucceededItem[] = [];

    /** Sentinel error used to abort the outer transaction. */
    class BatchAbort extends Error {
      constructor(
        public readonly index: number,
        public readonly executionId: string | undefined,
        public readonly errCode: string,
        public readonly errMessage: string,
      ) {
        super(errMessage);
      }
    }

    try {
      await txManager.runInTransaction(async (txProvider: DataProvider) => {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item) continue;
          const result = await execute(
            buildItemOptions(i, item, {
              provider: txProvider,
              events: sharedPendingEvents,
            }),
          );
          if (!result.success) {
            const err = extractErrorFromActionResult(result);
            throw new BatchAbort(i, result.executionId, err.code, err.message);
          }
          succeededInside.push(toSucceededItem(i, result));
        }
      }, sharedPendingEvents);
    } catch (err) {
      if (err instanceof BatchAbort) {
        return {
          success: false,
          parentExecutionId,
          strategy: "all_or_nothing",
          succeeded: [],
          failed: [
            {
              index: err.index,
              executionId: err.executionId,
              error: { code: err.errCode, message: err.errMessage },
            },
          ],
          rolledBack: succeededInside,
          summary: { total: items.length, succeeded: 0, failed: 1 },
        };
      }
      // Unexpected DB / runtime error — surface as a structured failure.
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        parentExecutionId,
        strategy: "all_or_nothing",
        succeeded: [],
        failed: [
          {
            index: succeededInside.length,
            error: { code: "BATCH_TRANSACTION_FAILED", message },
          },
        ],
        rolledBack: succeededInside,
        summary: { total: items.length, succeeded: 0, failed: 1 },
      };
    }

    return {
      success: true,
      parentExecutionId,
      strategy: "all_or_nothing",
      succeeded: succeededInside,
      failed: [],
      summary: {
        total: items.length,
        succeeded: succeededInside.length,
        failed: 0,
      },
    };
  }

  return { use, execute, executeBatch, getMiddlewares };
}

// ── Batch helpers ───────────────────────────────────────────

/** Map an `ActionResult.data` payload into a structured batch error. */
function extractErrorFromActionResult(result: ActionResult): {
  code: string;
  message: string;
  field?: string;
} {
  const data = result.data as Record<string, unknown> | undefined;
  const message = (data?.error as string) ?? "Action execution failed";
  const code = (data?.code as string) ?? "ACTION.EXECUTION.FAILED";
  const ctx = data?.context as Record<string, unknown> | undefined;
  const field = ctx?.field as string | undefined;
  return field ? { code, message, field } : { code, message };
}

/** Build a {@link BatchSucceededItem} from a successful {@link ActionResult}. */
function toSucceededItem(index: number, result: ActionResult): BatchSucceededItem {
  const item: BatchSucceededItem = { index, executionId: result.executionId };
  if (result.data !== undefined) item.data = result.data;
  if (result.record !== undefined) item.record = result.record;
  if (result.warnings !== undefined && result.warnings.length > 0) {
    item.warnings = [...result.warnings];
  }
  return item;
}

/** Construct a structured failure result for batch input validation. */
function buildBatchValidationFailure(
  parentExecutionId: string,
  strategy: "all_or_nothing" | "partial",
  code: string,
  message: string,
): BatchActionsResult {
  return {
    success: false,
    parentExecutionId,
    strategy,
    succeeded: [],
    failed: [{ index: 0, error: { code, message } }],
    summary: { total: 0, succeeded: 0, failed: 1 },
  };
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
