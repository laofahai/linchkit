/**
 * Error classification system
 *
 * 5 framework-level error types: ValidationError, AuthorizationError, BusinessRuleError, ConflictError, SystemError
 * Error code format: DOMAIN.CATEGORY.SPECIFIC
 */

// ── Error codes ──────────────────────────────────────────

export type ErrorCode = `${string}.${string}.${string}`;

// ── Base error ────────────────────────────────────────

export interface LinchKitErrorOptions {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ── Error variants ────────────────────────────────────────

export interface ValidationErrorData extends LinchKitErrorOptions {
  fields?: Array<{ field: string; message: string; value?: unknown }>;
}

export interface AuthorizationErrorData extends LinchKitErrorOptions {
  requiredRoles?: string[];
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
    type: "validation" | "authorization" | "business_rule" | "conflict" | "system";
    details?: Record<string, unknown>;
    fields?: ValidationErrorData["fields"];
    rules?: BusinessRuleErrorData["rules"];
    approvalId?: string;
    currentVersion?: number;
    currentState?: string;
  };
}

// ── HTTP status code mapping ─────────────────────────────────

export const ERROR_STATUS_MAP = {
  validation: 400,
  authorization: 401, // or 403
  business_rule: 422,
  conflict: 409,
  system: 500,
} as const;
