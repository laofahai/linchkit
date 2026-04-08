/**
 * Error classification system
 *
 * 7 framework-level error types (see spec 33_error_handling.md):
 *   validation, not_found, authentication, authorization, business_rule, conflict, system
 *
 * Error code format: DOMAIN.CATEGORY.SPECIFIC
 * HTTP status code mapping: see spec 16_command_layer_and_api.md §2.5
 */

// ── Error codes ──────────────────────────────────────────

export type ErrorCode = `${string}.${string}.${string}`;

// ── Error type union ─────────────────────────────────────

export type ErrorType =
  | "validation"
  | "not_found"
  | "authentication"
  | "authorization"
  | "business_rule"
  | "conflict"
  | "system";

// ── AI-friendly error context (Spec 60 §3.4) ────────────

/**
 * Structured context for AI agents to understand and fix errors autonomously.
 * Populated by engines (ActionEngine, RuleEngine, StateMachine, ValidationEngine).
 */
export interface ErrorContext {
  /** Which entity was involved */
  entity?: string;
  /** Which action was attempted */
  action?: string;
  /** Which field caused the issue */
  field?: string;
  /** Which constraint failed (rule name, validation name) */
  constraint?: string;
  /** What was expected */
  expected?: string;
  /** What was provided */
  actual?: string;
  /** What to change (human-readable suggestion) */
  suggestion?: string;
}

// ── Base error ────────────────────────────────────────

export interface LinchKitErrorOptions {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** i18n message key for client-side translation (e.g. "errors.validation.required") */
  messageKey?: string;
  /** i18n interpolation params for the messageKey template */
  messageParams?: Record<string, unknown>;
  /** AI-friendly error context (Spec 60 §3.4) */
  context?: ErrorContext;
}

// ── Error variants ────────────────────────────────────────

export interface ValidationErrorData extends LinchKitErrorOptions {
  fields?: Array<{ field: string; message: string; value?: unknown }>;
}

export interface NotFoundErrorData extends LinchKitErrorOptions {
  resource?: string;
  resourceId?: string;
}

export interface AuthorizationErrorData extends LinchKitErrorOptions {
  requiredGroups?: string[];
  requiredPermissions?: string[];
}

export interface BusinessRuleErrorData extends LinchKitErrorOptions {
  rules?: Array<{
    rule: string;
    effect: string;
    message: string;
  }>;
  approvalId?: string;
}

export interface ConflictErrorData extends LinchKitErrorOptions {
  currentVersion?: number;
  currentState?: string;
  expectedState?: string;
}

export interface SystemErrorData extends LinchKitErrorOptions {
  cause?: unknown;
}

// ── Unified error response ────────────────────────────────────

export interface LinchKitErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    type: ErrorType;
    details?: Record<string, unknown>;
    /** i18n message key for client-side translation */
    messageKey?: string;
    /** i18n interpolation params for the messageKey template */
    messageParams?: Record<string, unknown>;
    /** AI-friendly error context (Spec 60 §3.4) */
    context?: ErrorContext;
    fields?: ValidationErrorData["fields"];
    rules?: BusinessRuleErrorData["rules"];
    approvalId?: string;
    currentVersion?: number;
    currentState?: string;
  };
}

// ── HTTP status code mapping ─────────────────────────────────
// 401 = authentication (who are you?), 403 = authorization (no permission)

export const ERROR_STATUS_MAP: Record<ErrorType, number> = {
  validation: 400,
  not_found: 404,
  authentication: 401,
  authorization: 403,
  business_rule: 422,
  conflict: 409,
  system: 500,
} as const;
