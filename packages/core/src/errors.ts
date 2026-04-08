/**
 * Error class hierarchy for LinchKit
 *
 * 7 error types mapped to HTTP status codes (see spec 33_error_handling.md).
 * 401 = authentication (who are you?), 403 = authorization (no permission).
 */

import type {
  AuthorizationErrorData,
  BusinessRuleErrorData,
  ConflictErrorData,
  ErrorCode,
  ErrorContext,
  ErrorType,
  LinchKitErrorOptions,
  LinchKitErrorResponse,
  NotFoundErrorData,
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
  readonly type: ErrorType;
  readonly messageKey?: string;
  readonly messageParams?: Record<string, unknown>;
  /** AI-friendly error context for autonomous diagnosis (Spec 60 §3.4) */
  readonly context?: ErrorContext;

  constructor(options: LinchKitErrorOptions, type: ErrorType = "system") {
    super(options.message);
    this.name = "LinchKitError";
    this.code = options.code;
    this.details = options.details;
    this.type = type;
    this.statusCode = ERROR_STATUS_MAP[type];
    this.messageKey = options.messageKey;
    this.messageParams = options.messageParams;
    this.context = options.context;
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
        ...(this.messageKey !== undefined && { messageKey: this.messageKey }),
        ...(this.messageParams !== undefined && { messageParams: this.messageParams }),
        ...(this.context !== undefined && { context: this.context }),
      },
    };
  }
}

// ── Validation error (400) ──────────────────────────────

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

// ── Not found error (404) ───────────────────────────────

export class NotFoundError extends LinchKitError {
  readonly resource?: string;
  readonly resourceId?: string;

  constructor(options: NotFoundErrorData) {
    super(options, "not_found");
    this.name = "NotFoundError";
    this.resource = options.resource;
    this.resourceId = options.resourceId;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.resource || this.resourceId) {
      base.error.details = {
        ...base.error.details,
        ...(this.resource && { resource: this.resource }),
        ...(this.resourceId && { resourceId: this.resourceId }),
      };
    }
    return base;
  }
}

// ── Authentication error (401) ──────────────────────────

export class AuthenticationError extends LinchKitError {
  constructor(options: LinchKitErrorOptions) {
    super(options, "authentication");
    this.name = "AuthenticationError";
  }
}

// ── Authorization error (403) ───────────────────────────

export class AuthorizationError extends LinchKitError {
  readonly requiredGroups?: string[];
  readonly requiredPermissions?: string[];

  constructor(options: AuthorizationErrorData) {
    super(options, "authorization");
    this.name = "AuthorizationError";
    this.requiredGroups = options.requiredGroups;
    this.requiredPermissions = options.requiredPermissions;
  }

  override toResponse(): LinchKitErrorResponse {
    const base = super.toResponse();
    if (this.requiredGroups || this.requiredPermissions) {
      base.error.details = {
        ...base.error.details,
        ...(this.requiredGroups && { requiredGroups: this.requiredGroups }),
        ...(this.requiredPermissions && {
          requiredPermissions: this.requiredPermissions,
        }),
      };
    }
    return base;
  }
}

// ── Business rule error (422) ───────────────────────────

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

// ── Conflict error (409) ────────────────────────────────

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

// ── System error (500) ──────────────────────────────────

export class SystemError extends LinchKitError {
  override readonly cause?: unknown;

  constructor(options: SystemErrorData) {
    super(options, "system");
    this.name = "SystemError";
    this.cause = options.cause;
  }
}
