/**
 * Action Helpers
 *
 * Pure utility functions for action execution pipeline.
 * Extracted from action-engine.ts for maintainability.
 */

import type {
  ActionContext,
  ActionDefinition,
  ActionExposure,
  Actor,
  ValidationResult,
} from "../types/action";
import type { ExecutionChannel } from "./action-engine";

/**
 * Resolve a `$`-prefixed expression in declarative `setFields`.
 *
 * Supported:
 * - `$actor.id`, `$actor.name`, `$actor.type` — current actor fields
 * - `$input.<field>` — action input fields
 * - `$now` — current ISO timestamp
 * - `$now.date` — current ISO date (YYYY-MM-DD)
 * - Plain values pass through unchanged.
 */
export function resolveFieldExpression(
  value: unknown,
  input: Record<string, unknown>,
  actor: Actor,
): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;

  if (value === "$now") return new Date().toISOString();
  if (value === "$now.date") return new Date().toISOString().slice(0, 10);

  if (value.startsWith("$actor.")) {
    const field = value.slice("$actor.".length);
    return (actor as Record<string, unknown>)[field];
  }

  if (value.startsWith("$input.")) {
    const field = value.slice("$input.".length);
    return input[field];
  }

  // Unknown expression — return as-is
  return value;
}

export function generateExecutionId(): string {
  return `exec_${crypto.randomUUID()}`;
}

/** Check if the action is exposed for the given channel */
export function isExposed(
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
export function checkPermissions(action: ActionDefinition, actor: Actor): string | null {
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
export function validateInput(
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
export function runPreValidation(action: ActionDefinition, ctx: ActionContext): ValidationResult {
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
