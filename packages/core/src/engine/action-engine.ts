/**
 * Action Engine
 *
 * Manages action registration and execution.
 * Actions are the sole write entry point of the system.
 * Execution follows the unified execution contract (see spec 39).
 */

import { ConfigRegistry } from "../config/config-registry";
import type {
  ActionContext,
  ActionDefinition,
  ActionExposure,
  ActionResult,
  Actor,
  ValidationResult,
} from "../types/action";
import type { AIService } from "../types/ai";
import type { ExecutionLogEntry, ExecutionLogger } from "../types/execution-log";
import type { StateMachine } from "./state-machine";
import { canTransition } from "./state-machine";
import { getCurrentTrace } from "./trace-context";

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
  /** Skip permission check (already handled by CommandLayer permission middleware) */
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
  /** Idempotency key — if provided and an execution with this key already succeeded, return cached result */
  idempotencyKey?: string;
  /** Internal: current recursion depth for child action execution */
  _depth?: number;
  /** Internal: transactional data provider from parent action (shared transaction) */
  _txDataProvider?: DataProvider;
  /** Internal: parent's pending events array for shared transaction */
  _parentPendingEvents?: PendingEvent[];
}

// ── ActionRegistry ──────────────────────────────────────────

export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  /** Register an action definition. Throws on duplicate name unless overwrite is set. */
  register(action: ActionDefinition, opts?: { overwrite?: boolean }): void {
    if (!action.name) {
      throw new Error("Action must have a name");
    }
    if (this.actions.has(action.name) && !opts?.overwrite) {
      throw new Error(`Action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
  }

  /** Get an action by name, or undefined if not found */
  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  /** Get all registered actions */
  getAll(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  /** Get all actions for a given schema */
  getBySchema(schema: string): ActionDefinition[] {
    return this.getAll().filter((a) => a.schema === schema);
  }

  /** Check if an action is registered */
  has(name: string): boolean {
    return this.actions.has(name);
  }
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

// ── Helpers ─────────────────────────────────────────────────

let executionCounter = 0;

function generateExecutionId(): string {
  executionCounter++;
  return `exec_${Date.now()}_${executionCounter}`;
}

/** Check if the action is exposed for the given channel */
function isExposed(
  exposure: ActionExposure | "all" | undefined,
  channel: ExecutionChannel,
): boolean {
  // Default: all channels allowed
  if (exposure === undefined || exposure === "all") {
    return true;
  }

  const mapping: Record<ExecutionChannel, keyof ActionExposure> = {
    http: "http",
    mcp: "mcp",
    cli: "cli",
    ui: "ui",
    internal: "internal",
  };

  const key = mapping[channel];
  // If not explicitly set, default to true
  return exposure[key] !== false;
}

/** Check if the actor has permission to execute the action */
function checkPermissions(action: ActionDefinition, actor: Actor): string | null {
  const perms = action.permissions;
  if (!perms) {
    return null; // No restrictions
  }

  // Check actor type
  if (perms.actorTypes && perms.actorTypes.length > 0) {
    if (!perms.actorTypes.includes(actor.type)) {
      return `Actor type "${actor.type}" is not allowed for action "${action.name}"`;
    }
  }

  // Check permission groups
  if (perms.groups && perms.groups.length > 0) {
    const hasGroup = actor.groups.some((g) => perms.groups?.includes(g));
    if (!hasGroup) {
      return `Actor does not belong to any of the required groups: ${perms.groups.join(", ")}`;
    }
  }

  return null;
}

/** Validate required input fields */
function validateInput(action: ActionDefinition, input: Record<string, unknown>): ValidationResult {
  // Check required fields from input definition
  if (action.input) {
    const errors: Array<{ field: string; message: string }> = [];
    for (const [fieldName, fieldDef] of Object.entries(action.input)) {
      if (fieldDef.required && (input[fieldName] === undefined || input[fieldName] === null)) {
        errors.push({ field: fieldName, message: `Field "${fieldName}" is required` });
      }
    }
    if (errors.length > 0) {
      return { valid: false, errors };
    }
  }

  return { valid: true };
}

/** Run pre-validation (validate.required on the record, validate.custom) */
function runPreValidation(action: ActionDefinition, ctx: ActionContext): ValidationResult {
  if (!action.validate) {
    return { valid: true };
  }

  // validate.required checks fields on the input
  if (action.validate.required && action.validate.required.length > 0) {
    const errors: Array<{ field: string; message: string }> = [];
    for (const field of action.validate.required) {
      if (ctx.input[field] === undefined || ctx.input[field] === null || ctx.input[field] === "") {
        errors.push({ field, message: `Field "${field}" is required` });
      }
    }
    if (errors.length > 0) {
      return { valid: false, errors };
    }
  }

  // validate.custom — wrap in try/catch so exceptions don't escape
  if (action.validate.custom) {
    try {
      return action.validate.custom(ctx);
    } catch (err) {
      return {
        valid: false,
        errors: [
          {
            field: "_custom",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  return { valid: true };
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
  } = options;

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
        data: { error: `Action "${actionName}" not found` } as T,
        executionId,
      };
    }

    // Step 2 & 3: Exposure + Permission checks
    // Granular flags allow CommandLayer to skip only the checks it has handled
    const skipExposure = execOptions?.skipExposureCheck ?? false;
    const skipPermission = execOptions?.skipPermissionCheck ?? false;

    // Step 2: Exposure check — default channel to "internal" so the check always runs
    const channel: ExecutionChannel = execOptions?.channel ?? "internal";
    if (!skipExposure) {
      if (!isExposed(action.exposure, channel)) {
        const errorMsg = `Action "${actionName}" is not exposed for channel "${channel}"`;
        await logExecution({
          id: executionId,
          action: actionName,
          schema: action.schema,
          actor,
          input,
          status: "blocked",
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

    // Step 3: Permission check
    if (!skipPermission) {
      const permError = checkPermissions(action, actor);
      if (permError) {
        await logExecution({
          id: executionId,
          action: actionName,
          schema: action.schema,
          actor,
          input,
          status: "blocked",
          error: { message: permError },
          startedAt,
        });
        return {
          success: false,
          data: { error: permError } as T,
          executionId,
        };
      }
    }

    // Step 4: Input validation
    const inputValidation = validateInput(action, input);
    if (!inputValidation.valid) {
      await logExecution({
        id: executionId,
        action: actionName,
        schema: action.schema,
        actor,
        input,
        status: "failed",
        error: { message: "Input validation failed" },
        startedAt,
      });
      return {
        success: false,
        data: { error: "Input validation failed", details: inputValidation.errors } as T,
        executionId,
      };
    }

    // Build ActionContext
    const childExecutionIds: string[] = [];
    const pendingEvents: PendingEvent[] = [];
    const noopAi: AIService = {
      complete: () => {
        throw new Error(
          "AI service is not configured. Add an 'ai' section to your LinchKit config.",
        );
      },
    };
    // Build DataQueryOptions from ExecuteOptions for tenant isolation and locale
    const queryOptions: DataQueryOptions | undefined =
      execOptions?.tenantId || execOptions?.locale
        ? { tenantId: execOptions?.tenantId, locale: execOptions?.locale }
        : undefined;

    // Mutable provider reference — reassigned inside transaction callback
    // so that ctx closures automatically use the transactional connection.
    let activeProvider: DataProvider = dataProvider;

    const ctx: ActionContext = {
      input,
      actor,
      ai: aiService ?? noopAi,
      config: configRegistry ?? ConfigRegistry.empty(),
      executionId,
      timestamp: startedAt,
      get: (schema, id) => activeProvider.get(schema, id, queryOptions),
      query: (schema, filter) => activeProvider.query(schema, filter, queryOptions),
      create: (schema, data) => activeProvider.create(schema, data),
      update: (schema, id, data) => activeProvider.update(schema, id, data, queryOptions),
      delete: (schema, id) => activeProvider.delete(schema, id, queryOptions),
      execute: async (childActionName, childInput) => {
        const childResult = await execute(childActionName, childInput, actor, {
          ...execOptions,
          _depth: currentDepth + 1,
          _txDataProvider: activeProvider,
          _parentPendingEvents: pendingEvents,
        });
        childExecutionIds.push(childResult.executionId);
        return childResult.data;
      },
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
      await logExecution({
        id: executionId,
        action: actionName,
        schema: action.schema,
        actor,
        input,
        status: "failed",
        error: { message: "Validation failed" },
        startedAt,
      });
      return {
        success: false,
        data: { error: "Validation failed", details: preValidation.errors } as T,
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
          const record = await dataProvider.get(action.schema, recordId, queryOptions);
          currentState = record.status as string | undefined;
        } catch {
          // Record fetch failed — fail closed when state transition is required
          const errorMsg = `Cannot verify state transition: record "${recordId}" not found in schema "${action.schema}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            schema: action.schema,
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
            schema: action.schema,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: { error: errorMsg } as T,
            executionId,
          };
        }

        // Also validate against state machine if available
        if (!canTransition(stateMachine, currentState, actionName)) {
          const errorMsg = `State machine does not allow action "${actionName}" from state "${currentState}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            schema: action.schema,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: { error: errorMsg } as T,
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
          // Declarative action
          const recordId = input.id as string | undefined;

          if (recordId) {
            const updates: Record<string, unknown> = {};

            if (action.setFields) {
              Object.assign(updates, action.setFields);
            }

            if (action.stateTransition) {
              updates.status = action.stateTransition.to;
            }

            if (Object.keys(updates).length > 0) {
              record = await dp.update(action.schema, recordId, updates, queryOptions);
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
        await runHandler(parentTxProvider);
        // Propagate child events to parent's pending list so they are
        // persisted atomically when the parent's transaction commits.
        if (parentEvents) {
          parentEvents.push(...pendingEvents);
        }
      } else if (useTransaction) {
        await transactionManager.runInTransaction(
          (txProvider) => runHandler(txProvider),
          pendingEvents,
        );
      } else {
        await runHandler(dataProvider);
      }

      await logExecution({
        id: executionId,
        action: actionName,
        schema: action.schema,
        actor,
        input,
        output: resultData,
        status: "succeeded",
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        idempotencyKey,
        startedAt,
      });

      return {
        success: true,
        data: resultData as T,
        record,
        executionId,
      };
    } catch (err) {
      // On failure, pendingEvents were NOT persisted (transaction rolled back)
      await logExecution({
        id: executionId,
        action: actionName,
        schema: action.schema,
        actor,
        input,
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        startedAt,
      });
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
