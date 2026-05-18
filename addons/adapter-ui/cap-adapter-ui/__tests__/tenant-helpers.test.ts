import { describe, expect, it } from "bun:test";
import {
  formatBytes,
  formatUsageRatio,
  INVITABLE_ROLES,
  isInvitableRole,
  isValidEmail,
  isValidHexColor,
} from "../src/tenant/tenant-helpers";

describe("isValidEmail", () => {
  it("accepts a well-formed address", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidEmail("  user@example.com  ")).toBe(true);
  });

  it("rejects missing @, missing TLD, or empty input", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("user@nodomain")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("isValidHexColor", () => {
  it("accepts 6-digit hex with leading #", () => {
    expect(isValidHexColor("#2563eb")).toBe(true);
  });

  it("accepts 3-digit shorthand", () => {
    expect(isValidHexColor("#abc")).toBe(true);
  });

  it("rejects values missing the leading # or with bad characters", () => {
    expect(isValidHexColor("2563eb")).toBe(false);
    expect(isValidHexColor("#zzzzzz")).toBe(false);
    expect(isValidHexColor("#12")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("returns 0 B for zero or negative input", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-42)).toBe("0 B");
  });

  it("formats bytes using binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });

  it("handles non-finite numbers gracefully", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatUsageRatio", () => {
  it("returns a clamped percentage with a single decimal", () => {
    expect(formatUsageRatio(50, 100)).toBe("50.0%");
    expect(formatUsageRatio(33, 100)).toBe("33.0%");
  });

  it("clamps to 100% when used exceeds limit", () => {
    expect(formatUsageRatio(250, 100)).toBe("100.0%");
  });

  it("returns 0% when limit is non-positive or inputs are invalid", () => {
    expect(formatUsageRatio(10, 0)).toBe("0%");
    expect(formatUsageRatio(10, -5)).toBe("0%");
    expect(formatUsageRatio(Number.NaN, 100)).toBe("0%");
  });
});

describe("isInvitableRole", () => {
  it("returns true for admin / member / viewer", () => {
    expect(isInvitableRole("admin")).toBe(true);
    expect(isInvitableRole("member")).toBe(true);
    expect(isInvitableRole("viewer")).toBe(true);
  });

  it("returns false for owner (cannot be assigned via invite)", () => {
    expect(isInvitableRole("owner")).toBe(false);
  });

  it("returns false for unknown role strings", () => {
    expect(isInvitableRole("superuser")).toBe(false);
    expect(isInvitableRole("")).toBe(false);
  });
});

describe("INVITABLE_ROLES", () => {
  it("exposes the curated invite-time role list without owner", () => {
    expect([...INVITABLE_ROLES]).toEqual(["admin", "member", "viewer"]);
  });
});
