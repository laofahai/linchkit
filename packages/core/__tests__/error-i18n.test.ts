/**
 * Tests for messageKey / messageParams i18n support on LinchKitError
 */

import { describe, expect, it } from "bun:test";
import {
  LinchKitError,
  ValidationError,
  NotFoundError,
  BusinessRuleError,
} from "../src/errors";

describe("LinchKitError messageKey / messageParams", () => {
  it("should accept messageKey and messageParams in constructor", () => {
    const err = new LinchKitError({
      code: "order.validation.required",
      message: "Field is required",
      messageKey: "errors.validation.required",
      messageParams: { field: "name" },
    });

    expect(err.messageKey).toBe("errors.validation.required");
    expect(err.messageParams).toEqual({ field: "name" });
  });

  it("toResponse() should include messageKey and messageParams", () => {
    const err = new LinchKitError({
      code: "order.validation.required",
      message: "Field is required",
      messageKey: "errors.validation.required",
      messageParams: { field: "name", minLength: 3 },
    });
    const res = err.toResponse();

    expect(res.error.messageKey).toBe("errors.validation.required");
    expect(res.error.messageParams).toEqual({ field: "name", minLength: 3 });
  });

  it("toResponse() should omit messageKey and messageParams when not provided", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
    });
    const res = err.toResponse();

    expect(res.error).not.toHaveProperty("messageKey");
    expect(res.error).not.toHaveProperty("messageParams");
  });

  it("toResponse() should omit messageParams when only messageKey provided", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
      messageKey: "errors.general.fail",
    });
    const res = err.toResponse();

    expect(res.error.messageKey).toBe("errors.general.fail");
    expect(res.error).not.toHaveProperty("messageParams");
  });

  it("ValidationError should propagate messageKey through toResponse()", () => {
    const err = new ValidationError({
      code: "user.validation.email",
      message: "Invalid email",
      messageKey: "errors.validation.email.invalid",
      fields: [{ field: "email", message: "must be valid email" }],
    });
    const res = err.toResponse();

    expect(res.error.messageKey).toBe("errors.validation.email.invalid");
    expect(res.error.fields).toEqual([{ field: "email", message: "must be valid email" }]);
  });

  it("NotFoundError should propagate messageKey through toResponse()", () => {
    const err = new NotFoundError({
      code: "order.not_found.order",
      message: "Order not found",
      messageKey: "errors.not_found.order",
      messageParams: { id: "order-123" },
      resource: "order",
      resourceId: "order-123",
    });
    const res = err.toResponse();

    expect(res.error.messageKey).toBe("errors.not_found.order");
    expect(res.error.messageParams).toEqual({ id: "order-123" });
  });

  it("BusinessRuleError should propagate messageKey through toResponse()", () => {
    const err = new BusinessRuleError({
      code: "order.rule.credit",
      message: "Credit limit exceeded",
      messageKey: "errors.business.credit_limit",
      messageParams: { limit: 10000, requested: 15000 },
    });
    const res = err.toResponse();

    expect(res.error.messageKey).toBe("errors.business.credit_limit");
    expect(res.error.messageParams).toEqual({ limit: 10000, requested: 15000 });
  });
});
