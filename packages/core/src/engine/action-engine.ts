/**
 * Action Engine
 *
 * Manages action registration and execution.
 * Actions are the sole write entry point of the system.
 * Execution follows the unified execution contract (see spec 39).
 */

import { ConfigRegistry } from "../config/config-registry";
import type { EventBus } from "../event/event-bus";
import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import { getCurrentTrace } from "../observability/trace-context";
import { createTenantAwareDataProvider } from "../security/tenant-isolation";
import type { ActionContext, ActionResult, Actor } from "../types/action";
import type { AIService } from "../types/ai";
import type { ExecutionLogEntry, ExecutionLogger } from "../types/execution-log";
import type { ExecutionMeta } from "../types/execution-meta";
import { createExecutionMeta, extendExecutionMeta, MetaSizeError } from "../types/execution-meta";
import type { Logger } from "../types/logger";
import type { StateMachine } from "./state-machine";
import { canTransition, getAvailableActions } from "./state-machine";

export { ActionRegistry } from "./action-registry";

import {
  checkActorType,
  generateExecutionId,
  isExposed,
  resolveFieldExpression,
  runPreValidation,
  validateInput,
} from "./action-helpers";
import { ActionRegistry } from "./action-registry";

// ── DataProvider interface ──────────────────────────────────

/** Options for data queries — tenant isolation, soft-delete control, and locale */
export interface DataQueryOptions {
  tenantId?: string;
  includeDeleted?: boolean;
  /** Locale for resolving translatable fields (e.g., "zh-CN", "en") */
  locale?: string;
}

/** Abstraction for data access — injected into the executor for testability */
export interface DataProvider {
  get(schema: string, id: string, options?: DataQueryOptions): Promise<Record<string, unknown>>;
  query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>>;
  create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>>;
  delete(schema: string, id: string, options?: DataQueryOptions): Promise<void>;
  count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number>;
}

// ── Execution channel (for exposure checks) ─────────────────

export type ExecutionChannel = "http" | "mcp" | "cli" | "ui" | "internal";

// ── Execute options ─────────────────────────────────────────

export interface ExecuteOptions {
  channel?: ExecutionChannel;
  /** Skip exposure check (already handled by CommandLayer built-in exposure slot) */
  skipExposureCheck?: boolean;
  /**
   * @deprecated Group authorization no longer runs inside the Action Engine
   * (issue #125). The executor ignores this flag; permissions are enforced
   * exclusively by the CommandLayer "permission" slot. Retained for source
   * compatibility with older CommandLayer middleware that still sets it.
   */
  skipPermissionCheck?: boolean;
  /** Tenant ID resolved by CommandLayer */
  tenantId?: string;
  /** Locale for resolving translatable fields on read */
  locale?: string;
  /**
   * Rule names to skip during re-execution after approval.
   * The CommandLayer / caller is responsible for checking this list
   * before evaluating rules, so approved actions don't re-trigger
   * the same approval flow.
   */
  skipRules?: string[];
  /** Approval ID that authorized this re-execution */
  approvalId?: string;
  /** Include soft-deleted records in data operations (used by restore action) */
  includeDeleted?: boolean;
  /** Idempotency key — if provided and an execution with this key already succeeded, return cached result */
  idempotencyKey?: string;
  /** Internal: current recursion depth for child action execution */
  _depth?: number;
  /** Internal: transactional data provider from parent action (shared transaction) */
  _txDataProvider?: DataProvider;
  /** Internal: parent's pending events array for shared transaction */
  _parentPendingEvents?: PendingEvent[];
  /**
   * Execution metadata propagated through the execution chain (Spec 65).
   *
   * Normally set by the CommandLayer from `CommandExecuteOptions.meta` +
   * framework system keys, and by the ActionEngine itself on nested
   * `ctx.execute` calls. When absent (direct internal executor calls), the
   * ActionEngine synthesizes a default meta containing only system keys so
   * `ctx.meta` is always populated.
   */
  meta?: ExecutionMeta;
}

// ── ActionExecutor ──────────────────────────────────────────

export interface ActionExecutor {
  readonly registry: ActionRegistry;

  execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    options?: ExecuteOptions,
  ): Promise<ActionResult<T>>;
}

// ── Transactional event collection ──────────────────────────

/** Data needed to persist an event within a transaction */
export interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string;
  sourceAction?: string;
  sourceExecutionId?: string;
  /** Trace ID for restoring the trace chain in OutboxWorker */
  traceId?: string;
}

/**
 * Abstraction for running action handlers within database transactions.
 * Implementations handle DB-specific transaction management.
 *
 * When a TransactionManager is provided, the executor wraps handler
 * execution in a transaction. After the handler succeeds, pendingEvents
 * collected via ctx.emit() are written to the events table within the
 * same transaction — guaranteeing atomicity (Transactional Outbox pattern).
 */
export interface TransactionManager {
  /**
   * Execute fn within a database transaction.
   * @param fn - Receives a transactional DataProvider; all data ops use the same tx.
   * @param pendingEvents - Events collected during handler execution; persisted in the same tx.
   * @returns The value returned by fn.
   */
  runInTransaction<T>(
    fn: (txDataProvider: DataProvider) => Promise<T>,
    pendingEvents: PendingEvent[],
  ): Promise<T>;
}

// ── Factory ─────────────────────────────────────────────────

export interface ActionExecutorOptions {
  dataProvider: DataProvider;
  /** Transaction manager for wrapping handler execution in DB transactions.
   *  When provided, actions run within a transaction and events are persisted atomically. */
  transactionManager?: TransactionManager;
  stateMachine?: StateMachine;
  executionLogger?: ExecutionLogger;
  /** AI service instance — optional, noop if not provided */
  aiService?: AIService;
  /** Config registry — injected into ActionContext for type-safe config access.
   *  Falls back to an empty registry when omitted (e.g. in tests). */
  configRegistry?: ConfigRegistry;
  /** Metrics collector — optional, defaults to noopMetricsCollector (zero overhead) */
  metrics?: MetricsCollector;
  /** Logger instance — injected into ActionContext for handler-level logging.
   *  Falls back to a silent noop logger when omitted. */
  logger?: Logger;
  /** Event bus for emitting action lifecycle events (action.succeeded, action.failed) */
  eventBus?: EventBus;
  /** Names of registered capabilities — enables ctx.hasCapability() for weak dependency checks */
  capabilityNames?: ReadonlySet<string>;
}

/**
 * Create an ActionExecutor instance.
 *
 * The executor follows the simplified M0b execution flow:
 * 1. Look up action definition
 * 2. Exposure check
 * 3. Permission check
 * 4. Input validation
 * 5. Pre-validation (validate.required, validate.custom)
 * 6. State transition check
 * 7. Execute (declarative or handler)
 * 8. Return ActionResult
 */
export function createActionExecutor(options: ActionExecutorOptions): ActionExecutor {
  const registry = new ActionRegistry();
  const {
    dataProvider,
    transactionManager,
    stateMachine,
    executionLogger,
    aiService,
    configRegistry,
    metrics = noopMetricsCollector,
    logger: injectedLogger,
    eventBus,
    capabilityNames = new Set<string>(),
  } = options;

  /** Silent noop logger — used when no logger is injected */
  const noopFn = () => {};
  const noopLogger: Logger = { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn };
  const logger: Logger = injectedLogger ?? noopLogger;

  /** Helper: build and log an execution entry */
  async function logExecution(
    entry: Omit<ExecutionLogEntry, "completedAt" | "duration"> & { startedAt: Date },
  ): Promise<void> {
    if (!executionLogger) return;
    const completedAt = new Date();
    const duration = completedAt.getTime() - entry.startedAt.getTime();
    await executionLogger.log({ ...entry, completedAt, duration } as ExecutionLogEntry);
  }

  /** Maximum recursion depth for child action execution */
  const MAX_CHILD_DEPTH = 10;

  async function execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    execOptions?: ExecuteOptions,
  ): Promise<ActionResult<T>> {
    const executionId = generateExecutionId();
    const startedAt = new Date();

    // Step 0: Recursion depth check
    const currentDepth = execOptions?._depth ?? 0;
    if (currentDepth > MAX_CHILD_DEPTH) {
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: `Maximum child action recursion depth (${MAX_CHILD_DEPTH}) exceeded` },
        startedAt,
      });
      return {
        success: false,
        data: {
          error: `Maximum child action recursion depth (${MAX_CHILD_DEPTH}) exceeded`,
        } as T,
        executionId,
      };
    }

    // Step 0b: Idempotency check
    // Scope key by action name + tenant to prevent cross-action/cross-tenant collisions.
    // Only apply at top level — child executions (depth > 0) do not inherit idempotency.
    const rawIdempotencyKey = currentDepth === 0 ? execOptions?.idempotencyKey : undefined;
    const idempotencyKey = rawIdempotencyKey
      ? `${actionName}:${execOptions?.tenantId ?? ""}:${rawIdempotencyKey}`
      : undefined;
    if (idempotencyKey && executionLogger?.getByIdempotencyKey) {
      const existing = await executionLogger.getByIdempotencyKey(idempotencyKey);
      if (existing && existing.status === "succeeded") {
        return {
          success: true,
          data: existing.output as T,
          executionId: existing.id,
        };
      }
    }

    // Step 1: Look up action
    const action = registry.get(actionName);
    if (!action) {
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: `Action "${actionName}" not found` },
        startedAt,
      });
      return {
        success: false,
        data: {
          error: `Action "${actionName}" not found`,
          context: {
            action: actionName,
            suggestion: `Check action name spelling or register the action with defineAction({ name: "${actionName}", ... })`,
          },
        } as T,
        executionId,
      };
    }

    // Step 2: Exposure check.
    // Granular flag allows CommandLayer to skip the check it has already handled.
    //
    // Note: `skipPermissionCheck` is a no-op on the executor after #125 — group
    // authorization lives exclusively in cap-permission via the CommandLayer
    // "permission" slot. Actor-type enforcement (Spec 10 §5) is applied in
    // Step 3 below and runs on every execution path (REST, GraphQL, MCP,
    // direct internal execute) so actor-type gating can't be bypassed.
    const skipExposure = execOptions?.skipExposureCheck ?? false;

    // Exposure check — default channel to "internal" so the check always runs
    const channel: ExecutionChannel = execOptions?.channel ?? "internal";
    if (!skipExposure) {
      if (!isExposed(action.exposure, channel)) {
        const errorMsg = `Action "${actionName}" is not exposed for channel "${channel}"`;
        await logExecution({
          id: executionId,
          action: actionName,
          entity: action.entity,
          actor,
          input,
          status: "blocked",
          error: { message: errorMsg },
          startedAt,
        });
        return {
          success: false,
          data: {
            error: errorMsg,
            context: {
              action: actionName,
              entity: action.entity,
              constraint: "exposure",
              expected: `Action exposed for channel "${channel}"`,
              actual: `Not exposed for "${channel}"`,
              suggestion: `Add exposure config: defineAction({ ..., exposure: { ${channel}: true } })`,
            },
          } as T,
          executionId,
        };
      }
    }

    // Step 3: Actor-type check — Spec 10 authorization field declared on the
    // action itself. Group enforcement moved to the CommandLayer "permission"
    // slot (cap-permission) in #125, but actor-type filtering must hold on
    // every entry point, including GraphQL and direct executor callers.
    const actorTypeError = checkActorType(action, actor);
    if (actorTypeError) {
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "blocked",
        error: { message: actorTypeError },
        startedAt,
      });
      return {
        success: false,
        data: { error: actorTypeError } as T,
        executionId,
      };
    }

    // Step 4: Input validation.
    const inputValidation = validateInput(action, input);
    if (!inputValidation.valid) {
      const firstError = inputValidation.errors?.[0];
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: "Input validation failed" },
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Input validation failed",
          details: inputValidation.errors,
          context: {
            action: actionName,
            entity: action.entity,
            field: firstError?.field,
            constraint: "input_validation",
            expected: firstError?.message,
            suggestion: firstError
              ? `Fix field "${firstError.field}": ${firstError.message}`
              : "Check action input against the defined input schema",
          },
        } as T,
        executionId,
      };
    }

    // Build ActionContext
    const childExecutionIds: string[] = [];
    const pendingEvents: PendingEvent[] = [];
    const noopAi: AIService = {
      configured: false,
      defaultProvider: null,
      providerNames: [],
      complete: () => {
        throw new Error(
          "AI service is not configured. Add an 'ai' section to your LinchKit config.",
        );
      },
    };
    // Build DataQueryOptions for locale and includeDeleted (tenant isolation is now handled by the provider wrapper)
    const queryOptions: DataQueryOptions | undefined =
      execOptions?.locale || execOptions?.includeDeleted
        ? { locale: execOptions?.locale, includeDeleted: execOptions?.includeDeleted }
        : undefined;

    // Wrap the base DataProvider with tenant isolation when tenantId is present.
    // This enforces row-level tenant scoping on ALL data operations (get/query/create/update/delete/count).
    const baseProvider: DataProvider = execOptions?.tenantId
      ? createTenantAwareDataProvider(dataProvider, execOptions.tenantId)
      : dataProvider;

    // Mutable provider reference — reassigned inside transaction callback
    // so that ctx closures automatically use the transactional connection.
    let activeProvider: DataProvider = baseProvider;

    // Resolve execution meta: CommandLayer-provided meta takes precedence.
    // When absent (direct internal executor calls), synthesize a default meta
    // with only system keys so `ctx.meta` is always populated (Spec 65 §2.2).
    // Size-limit validation has already happened at construction time in the
    // CommandLayer for external paths — this synthesized meta is tiny.
    const resolvedMeta: ExecutionMeta =
      execOptions?.meta ??
      createExecutionMeta({
        systemKeys: {
          _channel: channel,
          _execution_id: executionId,
          _depth: currentDepth,
        },
      });

    const ctx: ActionContext = {
      input,
      actor,
      tenantId: execOptions?.tenantId,
      logger,
      signal: undefined,
      ai: aiService ?? noopAi,
      config: configRegistry ?? ConfigRegistry.empty(),
      executionId,
      timestamp: startedAt,
      meta: resolvedMeta,
      get: (entity, id) => activeProvider.get(entity, id, queryOptions),
      query: (entity, filter) => activeProvider.query(entity, filter, queryOptions),
      create: (entity, data) => activeProvider.create(entity, data),
      update: (entity, id, data) => activeProvider.update(entity, id, data, queryOptions),
      delete: (entity, id) => activeProvider.delete(entity, id, queryOptions),
      execute: async (childActionName, childInput, childOpts) => {
        // Extend parent meta for the child call: parent keys always win (§4.3),
        // framework updates _depth and _source_action unconditionally (§4.4),
        // and the root _execution_id is preserved across the chain.
        // Using the standalone extendExecutionMeta helper keeps the public
        // ExecutionMeta interface read-only from the handler's perspective —
        // handlers can't accidentally mutate meta by calling `.extend(...)`
        // on `ctx.meta`.
        // `extend` enforces the same filter + size limit as root meta
        // construction. If the merged child payload exceeds 8 KB, surface the
        // error as a failed ActionResult rather than letting the exception
        // bubble up and crash the parent handler — consistent with how other
        // child failures flow back to the caller (ctx.execute returns result.data).
        let childMeta: ExecutionMeta;
        try {
          childMeta = extendExecutionMeta(resolvedMeta, childOpts?.meta ?? {}, {
            _depth: currentDepth + 1,
            _source_action: actionName,
          });
        } catch (err) {
          if (err instanceof MetaSizeError) {
            const failedId = generateExecutionId();
            childExecutionIds.push(failedId);
            return { error: err.message, code: err.code };
          }
          throw err;
        }
        const childResult = await execute(childActionName, childInput, actor, {
          ...execOptions,
          _depth: currentDepth + 1,
          _txDataProvider: activeProvider,
          _parentPendingEvents: pendingEvents,
          meta: childMeta,
        });
        childExecutionIds.push(childResult.executionId);
        return childResult.data;
      },
      hasCapability: (name: string) => capabilityNames.has(name),
      emit: (eventType, payload) => {
        const trace = getCurrentTrace();
        pendingEvents.push({
          type: eventType,
          payload,
          tenantId: execOptions?.tenantId,
          sourceAction: actionName,
          sourceExecutionId: executionId,
          traceId: trace?.traceId,
        });
      },
    };

    // Step 5: Pre-validation
    const preValidation = runPreValidation(action, ctx);
    if (!preValidation.valid) {
      const firstError = preValidation.errors?.[0];
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: "Validation failed" },
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Validation failed",
          details: preValidation.errors,
          context: {
            action: actionName,
            entity: action.entity,
            constraint: "pre_validation",
            field: firstError?.field,
            expected: firstError?.message,
            suggestion: firstError
              ? `Fix field "${firstError.field}": ${firstError.message}`
              : "Check input values against action validation rules",
          },
        } as T,
        executionId,
      };
    }

    // Step 6: State transition check
    let stateTransitionRecord: { from: string; to: string } | undefined;

    if (action.stateTransition && stateMachine) {
      const fromStates = Array.isArray(action.stateTransition.from)
        ? action.stateTransition.from
        : [action.stateTransition.from];

      // Get current state from input or record
      const recordId = input.id as string | undefined;
      let currentState: string | undefined;

      if (recordId) {
        try {
          const record = await baseProvider.get(action.entity, recordId, queryOptions);
          currentState = record.status as string | undefined;
        } catch {
          // Record fetch failed — fail closed when state transition is required
          const errorMsg = `Cannot verify state transition: record "${recordId}" not found in entity "${action.entity}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action.entity,
            actor,
            input,
            status: "failed",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: { error: errorMsg } as T,
            executionId,
          };
        }
      }

      if (currentState !== undefined) {
        // Check if current state is in the allowed "from" states
        if (!fromStates.includes(currentState)) {
          const errorMsg = `State transition not allowed: current state "${currentState}" is not in allowed states [${fromStates.join(", ")}]`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action.entity,
                action: actionName,
                field: "status",
                constraint: "state_transition",
                expected: `Current state in [${fromStates.join(", ")}]`,
                actual: `Current state is "${currentState}"`,
                suggestion: `Record is in "${currentState}" state. Allowed source states for "${actionName}" are: [${fromStates.join(", ")}]`,
              },
            } as T,
            executionId,
          };
        }

        // Also validate against state machine if available
        if (!canTransition(stateMachine, currentState, actionName)) {
          const available = getAvailableActions(stateMachine, currentState);
          const errorMsg = `State machine does not allow action "${actionName}" from state "${currentState}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action.entity,
                action: actionName,
                field: "status",
                constraint: "state_machine",
                expected: `Action "${actionName}" allowed from current state`,
                actual: `State "${currentState}" does not permit "${actionName}"`,
                suggestion:
                  available.length > 0
                    ? `Available actions from "${currentState}": [${available.join(", ")}]`
                    : `No actions available from state "${currentState}"`,
              },
            } as T,
            executionId,
          };
        }

        stateTransitionRecord = { from: currentState, to: action.stateTransition.to };
      }
    }

    // Step 7: Execute
    //
    // When a TransactionManager is provided, the handler runs within a
    // database transaction. Events collected via ctx.emit() are persisted
    // to _linchkit_events in the same transaction (Transactional Outbox).
    // On failure, both data changes and events roll back atomically.
    try {
      let resultData: unknown;
      let record: Record<string, unknown> | undefined;

      /** Run the action handler or declarative logic against a given DataProvider */
      const runHandler = async (dp: DataProvider): Promise<void> => {
        activeProvider = dp;
        if (action.handler) {
          resultData = await action.handler(ctx);
        } else {
          // Declarative action — no handler needed
          const recordId = input.id as string | undefined;

          if (recordId) {
            const updates: Record<string, unknown> = {};

            if (action.setFields) {
              for (const [key, value] of Object.entries(action.setFields)) {
                updates[key] = resolveFieldExpression(value, input, actor);
              }
            }

            if (action.stateTransition) {
              updates.status = action.stateTransition.to;
            }

            if (Object.keys(updates).length > 0) {
              record = await dp.update(action.entity, recordId, updates, queryOptions);
              resultData = record;
            }
          }
        }
      };

      // Use transaction when available and not explicitly disabled
      const useTransaction = transactionManager && action.policy?.transaction !== false;
      const parentTxProvider = execOptions?._txDataProvider;
      const parentEvents = execOptions?._parentPendingEvents;

      if (parentTxProvider) {
        // Shared transaction path: parent already opened a transaction.
        // Use the parent's transactional provider directly so all data
        // operations participate in the same DB transaction.
        // Note: parent already wraps with tenant isolation, so no double-wrap needed.
        await runHandler(parentTxProvider);
        // Propagate child events to parent's pending list so they are
        // persisted atomically when the parent's transaction commits.
        if (parentEvents) {
          parentEvents.push(...pendingEvents);
        }
      } else if (useTransaction) {
        await transactionManager.runInTransaction((txProvider) => {
          // Wrap the transactional provider with tenant isolation
          const scopedTxProvider = execOptions?.tenantId
            ? createTenantAwareDataProvider(txProvider, execOptions.tenantId)
            : txProvider;
          return runHandler(scopedTxProvider);
        }, pendingEvents);
      } else {
        await runHandler(baseProvider);
      }

      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: action.entity ?? "",
        status: "succeeded",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: action.entity ?? "",
      });

      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        output: resultData,
        status: "succeeded",
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        idempotencyKey,
        startedAt,
      });

      // Emit action.succeeded event to EventBus (non-blocking — must not affect action result)
      if (eventBus) {
        try {
          await eventBus.emit({
            id: crypto.randomUUID(),
            type: "action.succeeded",
            category: "runtime",
            timestamp: new Date(),
            actor: { type: actor.type, id: actor.id },
            entity: action.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              ...(typeof resultData === "object" && resultData !== null
                ? (resultData as Record<string, unknown>)
                : { result: resultData }),
            },
          });
        } catch {
          // Don't fail the action if event emission fails
        }

        // Flush pending events (from ctx.emit()) to in-memory EventBus subscribers.
        // Only flush at the root action level — child actions sharing a parent transaction
        // have their events merged into the parent's pendingEvents and will be flushed
        // when the parent's transaction commits.
        if (!execOptions?._txDataProvider && pendingEvents.length > 0) {
          for (const pe of pendingEvents) {
            try {
              await eventBus.emit({
                id: crypto.randomUUID(),
                type: pe.type,
                category: pe.type.startsWith("record.") ? "change" : "custom",
                timestamp: new Date(),
                actor: { type: actor.type, id: actor.id },
                entity: typeof pe.payload.entity === "string" ? pe.payload.entity : undefined,
                recordId: typeof pe.payload.recordId === "string" ? pe.payload.recordId : undefined,
                tenantId: pe.tenantId,
                executionId: pe.sourceExecutionId ?? executionId,
                payload: pe.payload,
              });
            } catch {
              // Non-blocking — don't fail the action if flush fails
            }
          }
        }
      }

      return {
        success: true,
        data: resultData as T,
        record,
        executionId,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: action.entity ?? "",
        status: "failed",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: action.entity ?? "",
      });

      // On failure, pendingEvents were NOT persisted (transaction rolled back)
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        startedAt,
      });

      // Emit action.failed event to EventBus (non-blocking — must not affect action result)
      if (eventBus) {
        try {
          await eventBus.emit({
            id: crypto.randomUUID(),
            type: "action.failed",
            category: "runtime",
            timestamp: new Date(),
            actor: { type: actor.type, id: actor.id },
            entity: action.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Don't fail the action if event emission fails
        }
      }

      return {
        success: false,
        data: {
          error: err instanceof Error ? err.message : String(err),
        } as T,
        executionId,
      };
    }
  }

  return {
    registry,
    execute,
  };
}
