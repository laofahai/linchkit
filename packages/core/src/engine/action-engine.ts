/**
 * Action Engine
 *
 * Manages action registration and execution.
 * Actions are the sole write entry point of the system.
 * Execution follows the unified execution contract (see spec 39).
 */

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

// ── DataProvider interface ──────────────────────────────────

/** Options for data queries — tenant isolation and soft-delete control */
export interface DataQueryOptions {
  tenantId?: string;
  includeDeleted?: boolean;
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
  /**
   * Rule names to skip during re-execution after approval.
   * The CommandLayer / caller is responsible for checking this list
   * before evaluating rules, so approved actions don't re-trigger
   * the same approval flow.
   */
  skipRules?: string[];
  /** Approval ID that authorized this re-execution */
  approvalId?: string;
  /** Internal: current recursion depth for child action execution */
  _depth?: number;
}

// ── ActionRegistry ──────────────────────────────────────────

export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  /** Register an action definition. Throws on duplicate name. */
  register(action: ActionDefinition): void {
    if (!action.name) {
      throw new Error("Action must have a name");
    }
    if (this.actions.has(action.name)) {
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

// ── Factory ─────────────────────────────────────────────────

export interface ActionExecutorOptions {
  dataProvider: DataProvider;
  stateMachine?: StateMachine;
  executionLogger?: ExecutionLogger;
  /** AI service instance — optional, noop if not provided */
  aiService?: AIService;
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
  const { dataProvider, stateMachine, executionLogger, aiService } = options;

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
    const noopAi: AIService = {
      complete: () => {
        throw new Error(
          "AI service is not configured. Add an 'ai' section to your LinchKit config.",
        );
      },
    };
    const ctx: ActionContext = {
      input,
      actor,
      ai: aiService ?? noopAi,
      executionId,
      timestamp: startedAt,
      get: (schema, id) => dataProvider.get(schema, id),
      query: (schema, filter) => dataProvider.query(schema, filter),
      create: (schema, data) => dataProvider.create(schema, data),
      update: (schema, id, data) => dataProvider.update(schema, id, data),
      delete: (schema, id) => dataProvider.delete(schema, id),
      execute: async (childActionName, childInput) => {
        const childResult = await execute(childActionName, childInput, actor, {
          _depth: currentDepth + 1,
        });
        childExecutionIds.push(childResult.executionId);
        return childResult.data;
      },
      emit: (_eventType, _payload) => {
        // M0b: event emission is a no-op
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
          const record = await dataProvider.get(action.schema, recordId);
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
    try {
      let resultData: unknown;
      let record: Record<string, unknown> | undefined;

      if (action.handler) {
        // Code-based action
        resultData = await action.handler(ctx);
      } else {
        // Declarative action
        const recordId = input.id as string | undefined;

        if (recordId) {
          const updates: Record<string, unknown> = {};

          // Apply setFields
          if (action.setFields) {
            Object.assign(updates, action.setFields);
          }

          // Apply state transition
          if (action.stateTransition) {
            updates.status = action.stateTransition.to;
          }

          if (Object.keys(updates).length > 0) {
            record = await dataProvider.update(action.schema, recordId, updates);
          }
        }
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
        startedAt,
      });

      return {
        success: true,
        data: resultData as T,
        record,
        executionId,
      };
    } catch (err) {
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
