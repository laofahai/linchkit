/**
 * Error class hierarchy for LinchKit
 *
 * Provides structured error types that map to HTTP status codes
 * and produce standardized error responses.
 */

import type {
  AuthorizationErrorData,
  BusinessRuleErrorData,
  ConflictErrorData,
  ErrorCode,
  LinchKitErrorOptions,
  LinchKitErrorResponse,
  SystemErrorData,
  ValidationErrorData,
} from "./types/error";
import { ERROR_STATUS_MAP } from "./types/error";

// ── Base error ──────────────────────────────────────────

/**
 * Base error class for all LinchKit errors.
 * Carries a structured error code and optional details.
 */
export class LinchKitError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly statusCode: number;
  readonly type: LinchKitErrorResponse["error"]["type"];

  constructor(
    options: LinchKitErrorOptions,
    type: LinchKitErrorResponse["error"]["type"] = "system",
  ) {
    super(options.message);
    this.name = "LinchKitError";
    this.code = options.code;
    this.details = options.details;
    this.type = type;
    this.statusCode = ERROR_STATUS_MAP[type];
  }

  /** Convert to a standardized error response object. */
  toResponse(): LinchKitErrorResponse {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        type: this.type,
        ...(this.details !== undefined && { details: this.details }),
      },
    };
  }
}

// ── Validation error ────────────────────────────────────

export class ValidationError extends LinchKitError {
  readonly fields?: ValidationErrorData["fields"];

  constructor(options: ValidationErrorData) {
    super(options, "validation");
    this.name = "ValidationError";
    this.fields = options.fields;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.fields) {
      base.error.fields = this.fields;
    }
    return base;
  }
}

// ── Authorization error ─────────────────────────────────

export class AuthorizationError extends LinchKitError {
  readonly requiredRoles?: string[];
  readonly requiredPermissions?: string[];

  constructor(options: AuthorizationErrorData) {
    super(options, "authorization");
    this.name = "AuthorizationError";
    this.requiredRoles = options.requiredRoles;
    this.requiredPermissions = options.requiredPermissions;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.requiredRoles || this.requiredPermissions) {
      base.error.details = {
        ...base.error.details,
        ...(this.requiredRoles && { requiredRoles: this.requiredRoles }),
        ...(this.requiredPermissions && {
          requiredPermissions: this.requiredPermissions,
        }),
      };
    }
    return base;
  }
}

// ── Business rule error ─────────────────────────────────

export class BusinessRuleError extends LinchKitError {
  readonly rules?: BusinessRuleErrorData["rules"];
  readonly approvalId?: string;

  constructor(options: BusinessRuleErrorData) {
    super(options, "business_rule");
    this.name = "BusinessRuleError";
    this.rules = options.rules;
    this.approvalId = options.approvalId;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.rules) {
      base.error.rules = this.rules;
    }
    if (this.approvalId) {
      base.error.approvalId = this.approvalId;
    }
    return base;
  }
}

// ── Conflict error ──────────────────────────────────────

export class ConflictError extends LinchKitError {
  readonly currentVersion?: number;
  readonly currentState?: string;
  readonly expectedState?: string;

  constructor(options: ConflictErrorData) {
    super(options, "conflict");
    this.name = "ConflictError";
    this.currentVersion = options.currentVersion;
    this.currentState = options.currentState;
    this.expectedState = options.expectedState;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.currentVersion !== undefined) {
      base.error.currentVersion = this.currentVersion;
    }
    if (this.currentState !== undefined) {
      base.error.currentState = this.currentState;
    }
    return base;
  }
}

// ── System error ────────────────────────────────────────

export class SystemError extends LinchKitError {
  override readonly cause?: unknown;

  constructor(options: SystemErrorData) {
    super(options, "system");
    this.name = "SystemError";
    this.cause = options.cause;
  }
}
