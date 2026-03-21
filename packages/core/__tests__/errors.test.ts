import { describe, expect, it } from "bun:test";
import {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "../src/errors";

// ── LinchKitError (base) ────────────────────────────────

describe("LinchKitError", () => {
  it("should construct with code, message, and details", () => {
    const err = new LinchKitError({
      code: "app.general.unknown",
      message: "Something went wrong",
      details: { hint: "try again" },
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("LinchKitError");
    expect(err.code).toBe("app.general.unknown");
    expect(err.message).toBe("Something went wrong");
    expect(err.details).toEqual({ hint: "try again" });
    expect(err.statusCode).toBe(500);
    expect(err.type).toBe("system");
  });

  it("toResponse() should return a LinchKitErrorResponse", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
    });
    const res = err.toResponse();

    expect(res.success).toBe(false);
    expect(res.error.code).toBe("app.general.fail");
    expect(res.error.message).toBe("Failure");
    expect(res.error.type).toBe("system");
    // details should be omitted when undefined
    expect(res.error).not.toHaveProperty("details");
  });

  it("toResponse() should include details when provided", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
      details: { foo: "bar" },
    });
    const res = err.toResponse();
    expect(res.error.details).toEqual({ foo: "bar" });
  });
});

// ── ValidationError ─────────────────────────────────────

describe("ValidationError", () => {
  it("should have status 400 and type validation", () => {
    const err = new ValidationError({
      code: "order.validation.invalid",
      message: "Invalid input",
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.name).toBe("ValidationError");
    expect(err.statusCode).toBe(400);
    expect(err.type).toBe("validation");
  });

  it("should carry fields array", () => {
    const fields = [
      { field: "email", message: "required", value: "" },
      { field: "age", message: "must be positive" },
    ];
    const err = new ValidationError({
      code: "user.validation.fields",
      message: "Validation failed",
      fields,
    });

    expect(err.fields).toEqual(fields);
  });

  it("toResponse() should include fields", () => {
    const fields = [{ field: "name", message: "too short" }];
    const err = new ValidationError({
      code: "user.validation.fields",
      message: "Validation failed",
      fields,
    });
    const res = err.toResponse();

    expect(res.error.type).toBe("validation");
    expect(res.error.fields).toEqual(fields);
  });

  it("toResponse() should omit fields when not provided", () => {
    const err = new ValidationError({
      code: "user.validation.general",
      message: "Bad request",
    });
    const res = err.toResponse();
    expect(res.error).not.toHaveProperty("fields");
  });
});

// ── NotFoundError ───────────────────────────────────────

describe("NotFoundError", () => {
  it("should have status 404 and type not_found", () => {
    const err = new NotFoundError({
      code: "record.not_found.order",
      message: "Order not found",
      resource: "order",
      resourceId: "order_999",
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("NotFoundError");
    expect(err.statusCode).toBe(404);
    expect(err.type).toBe("not_found");
    expect(err.resource).toBe("order");
    expect(err.resourceId).toBe("order_999");
  });

  it("toResponse() should include resource info in details", () => {
    const err = new NotFoundError({
      code: "action.not_found.action",
      message: "Action not found",
      resource: "action",
      resourceId: "submit_order",
    });
    const res = err.toResponse();

    expect(res.error.type).toBe("not_found");
    expect(res.error.details).toEqual({
      resource: "action",
      resourceId: "submit_order",
    });
  });
});

// ── AuthenticationError ─────────────────────────────────

describe("AuthenticationError", () => {
  it("should have status 401 and type authentication", () => {
    const err = new AuthenticationError({
      code: "auth.authentication.token_expired",
      message: "Token expired",
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("AuthenticationError");
    expect(err.statusCode).toBe(401);
    expect(err.type).toBe("authentication");
  });
});

// ── AuthorizationError ──────────────────────────────────

describe("AuthorizationError", () => {
  it("should have status 403 and type authorization", () => {
    const err = new AuthorizationError({
      code: "auth.access.denied",
      message: "Access denied",
      requiredGroups: ["admin"],
      requiredPermissions: ["write"],
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("AuthorizationError");
    expect(err.statusCode).toBe(403);
    expect(err.type).toBe("authorization");
    expect(err.requiredGroups).toEqual(["admin"]);
    expect(err.requiredPermissions).toEqual(["write"]);
  });

  it("toResponse() should include requiredGroups and requiredPermissions in details", () => {
    const err = new AuthorizationError({
      code: "auth.access.denied",
      message: "Forbidden",
      requiredGroups: ["manager"],
      requiredPermissions: ["approve"],
    });
    const res = err.toResponse();

    expect(res.error.type).toBe("authorization");
    expect(res.error.details).toEqual({
      requiredGroups: ["manager"],
      requiredPermissions: ["approve"],
    });
  });
});

// ── BusinessRuleError ───────────────────────────────────

describe("BusinessRuleError", () => {
  it("should have status 422 and type business_rule", () => {
    const err = new BusinessRuleError({
      code: "order.rule.limit",
      message: "Rule violated",
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("BusinessRuleError");
    expect(err.statusCode).toBe(422);
    expect(err.type).toBe("business_rule");
  });

  it("should carry multiple rules and an approvalId", () => {
    const rules = [
      { rule: "max_amount", effect: "block", message: "Over limit" },
      { rule: "min_items", effect: "warn", message: "Too few items" },
    ];
    const err = new BusinessRuleError({
      code: "order.rule.multi",
      message: "Multiple rules violated",
      rules,
      approvalId: "approval-123",
    });

    expect(err.rules).toEqual(rules);
    expect(err.approvalId).toBe("approval-123");
  });

  it("toResponse() should include rules and approvalId", () => {
    const rules = [{ rule: "credit_check", effect: "block", message: "Credit too low" }];
    const err = new BusinessRuleError({
      code: "order.rule.credit",
      message: "Credit check failed",
      rules,
      approvalId: "appr-456",
    });
    const res = err.toResponse();

    expect(res.error.rules).toEqual(rules);
    expect(res.error.approvalId).toBe("appr-456");
  });
});

// ── ConflictError ───────────────────────────────────────

describe("ConflictError", () => {
  it("should have status 409 and type conflict", () => {
    const err = new ConflictError({
      code: "order.conflict.version",
      message: "Version mismatch",
      currentVersion: 5,
      currentState: "submitted",
      expectedState: "draft",
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("ConflictError");
    expect(err.statusCode).toBe(409);
    expect(err.type).toBe("conflict");
    expect(err.currentVersion).toBe(5);
    expect(err.currentState).toBe("submitted");
    expect(err.expectedState).toBe("draft");
  });

  it("toResponse() should include version and state info", () => {
    const err = new ConflictError({
      code: "order.conflict.state",
      message: "State conflict",
      currentVersion: 3,
      currentState: "approved",
    });
    const res = err.toResponse();

    expect(res.error.type).toBe("conflict");
    expect(res.error.currentVersion).toBe(3);
    expect(res.error.currentState).toBe("approved");
  });
});

// ── SystemError ─────────────────────────────────────────

describe("SystemError", () => {
  it("should have status 500 and type system", () => {
    const cause = new Error("DB connection failed");
    const err = new SystemError({
      code: "infra.db.connection",
      message: "Database unavailable",
      cause,
    });

    expect(err).toBeInstanceOf(LinchKitError);
    expect(err.name).toBe("SystemError");
    expect(err.statusCode).toBe(500);
    expect(err.type).toBe("system");
    expect(err.cause).toBe(cause);
  });

  it("toResponse() should return standard system error response", () => {
    const err = new SystemError({
      code: "infra.cache.timeout",
      message: "Cache timeout",
    });
    const res = err.toResponse();

    expect(res.success).toBe(false);
    expect(res.error.type).toBe("system");
    expect(res.error.code).toBe("infra.cache.timeout");
  });
});

// ── Inheritance chain ───────────────────────────────────

describe("Error inheritance chain", () => {
  const errors = [
    new ValidationError({ code: "a.b.c", message: "v" }),
    new NotFoundError({ code: "a.b.c", message: "n" }),
    new AuthenticationError({ code: "a.b.c", message: "authn" }),
    new AuthorizationError({ code: "a.b.c", message: "authz" }),
    new BusinessRuleError({ code: "a.b.c", message: "b" }),
    new ConflictError({ code: "a.b.c", message: "c" }),
    new SystemError({ code: "a.b.c", message: "s" }),
  ];

  for (const err of errors) {
    it(`${err.name} should be instanceof Error and LinchKitError`, () => {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LinchKitError);
    });
  }
});
