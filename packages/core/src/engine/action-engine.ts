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
import type { StateMachine } from "./state-machine";
import { canTransition } from "./state-machine";

// ── DataProvider interface ──────────────────────────────────

/** Abstraction for data access — injected into the executor for testability */
export interface DataProvider {
  get(schema: string, id: string): Promise<Record<string, unknown>>;
  query(schema: string, filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  delete(schema: string, id: string): Promise<void>;
}

// ── Execution channel (for exposure checks) ─────────────────

export type ExecutionChannel = "http" | "mcp" | "cli" | "ui" | "internal";

// ── Execute options ─────────────────────────────────────────

export interface ExecuteOptions {
  channel?: ExecutionChannel;
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
function isExposed(exposure: ActionExposure | "all" | undefined, channel: ExecutionChannel): boolean {
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

  // Check roles
  if (perms.roles && perms.roles.length > 0) {
    const hasRole = actor.roles.some((r) => perms.roles!.includes(r));
    if (!hasRole) {
      return `Actor does not have any of the required roles: ${perms.roles.join(", ")}`;
    }
  }

  return null;
}

/** Validate required input fields */
function validateInput(
  action: ActionDefinition,
  input: Record<string, unknown>,
): ValidationResult {
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
function runPreValidation(
  action: ActionDefinition,
  ctx: ActionContext,
): ValidationResult {
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

  // validate.custom
  if (action.validate.custom) {
    return action.validate.custom(ctx);
  }

  return { valid: true };
}

// ── Factory ─────────────────────────────────────────────────

export interface ActionExecutorOptions {
  dataProvider: DataProvider;
  stateMachine?: StateMachine;
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
  const { dataProvider, stateMachine } = options;

  async function execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    execOptions?: ExecuteOptions,
  ): Promise<ActionResult<T>> {
    const executionId = generateExecutionId();

    // Step 1: Look up action
    const action = registry.get(actionName);
    if (!action) {
      return {
        success: false,
        data: { error: `Action "${actionName}" not found` } as T,
        executionId,
      };
    }

    // Step 2: Exposure check
    if (execOptions?.channel) {
      if (!isExposed(action.exposure, execOptions.channel)) {
        return {
          success: false,
          data: {
            error: `Action "${actionName}" is not exposed for channel "${execOptions.channel}"`,
          } as T,
          executionId,
        };
      }
    }

    // Step 3: Permission check
    const permError = checkPermissions(action, actor);
    if (permError) {
      return {
        success: false,
        data: { error: permError } as T,
        executionId,
      };
    }

    // Step 4: Input validation
    const inputValidation = validateInput(action, input);
    if (!inputValidation.valid) {
      return {
        success: false,
        data: { error: "Input validation failed", details: inputValidation.errors } as T,
        executionId,
      };
    }

    // Build ActionContext
    const ctx: ActionContext = {
      input,
      actor,
      executionId,
      timestamp: new Date(),
      get: (schema, id) => dataProvider.get(schema, id),
      query: (schema, filter) => dataProvider.query(schema, filter),
      create: (schema, data) => dataProvider.create(schema, data),
      update: (schema, id, data) => dataProvider.update(schema, id, data),
      delete: (schema, id) => dataProvider.delete(schema, id),
      execute: async (childActionName, childInput) => {
        const childResult = await execute(childActionName, childInput, actor);
        return childResult.data;
      },
      emit: (_eventType, _payload) => {
        // M0b: event emission is a no-op
      },
    };

    // Step 5: Pre-validation
    const preValidation = runPreValidation(action, ctx);
    if (!preValidation.valid) {
      return {
        success: false,
        data: { error: "Validation failed", details: preValidation.errors } as T,
        executionId,
      };
    }

    // Step 6: State transition check
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
          // Record not found — cannot check state
        }
      }

      if (currentState !== undefined) {
        // Check if current state is in the allowed "from" states
        if (!fromStates.includes(currentState)) {
          return {
            success: false,
            data: {
              error: `State transition not allowed: current state "${currentState}" is not in allowed states [${fromStates.join(", ")}]`,
            } as T,
            executionId,
          };
        }

        // Also validate against state machine if available
        if (!canTransition(stateMachine, currentState, actionName)) {
          return {
            success: false,
            data: {
              error: `State machine does not allow action "${actionName}" from state "${currentState}"`,
            } as T,
            executionId,
          };
        }
      }
    }

    // Step 7: Execute
    try {
      let resultData: unknown = undefined;
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

      return {
        success: true,
        data: resultData as T,
        record,
        executionId,
      };
    } catch (err) {
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
