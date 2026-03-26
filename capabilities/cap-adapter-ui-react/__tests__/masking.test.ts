import { describe, expect, test } from "bun:test";
import { isMaskedValue, isFullyMasked } from "../src/lib/masking";

describe("isMaskedValue", () => {
  describe("full mask — entire value is asterisks (≥3)", () => {
    test.each(["***", "****", "**********"])("detects %s", (v) => {
      expect(isMaskedValue(v)).toBe(true);
    });

    test("rejects fewer than 3 asterisks", () => {
      expect(isMaskedValue("*")).toBe(false);
      expect(isMaskedValue("**")).toBe(false);
    });
  });

  describe("partial mask — contiguous 3+ asterisks with short prefix/suffix", () => {
    test.each([
      "J***n",
      "****5678",
      "1234****",
      "1234****5678",
      "user****",
    ])("detects %s", (v) => {
      expect(isMaskedValue(v)).toBe(true);
    });
  });

  describe("email-style masks", () => {
    test.each([
      "***@email.com",
      "j***@example.com",
      "user@***.com",
    ])("detects %s", (v) => {
      expect(isMaskedValue(v)).toBe(true);
    });
  });

  describe("false-positive resistance — normal text must NOT match", () => {
    test.each([
      "**bold**",
      "a ** b",
      "p**sword",
      "2 * 3 * 4",
      "hello world",
      "no asterisks here",
      "single * star",
      "double ** star",
      "foo *** bar",        // spaces around asterisks — not a mask pattern
      "some text ****",     // leading space — not a mask pattern
      "**** some text",     // trailing text with space — not a mask pattern
    ])("rejects %s", (v) => {
      expect(isMaskedValue(v)).toBe(false);
    });
  });

  describe("non-string values", () => {
    test("rejects non-string types", () => {
      expect(isMaskedValue(null)).toBe(false);
      expect(isMaskedValue(undefined)).toBe(false);
      expect(isMaskedValue(123)).toBe(false);
      expect(isMaskedValue(true)).toBe(false);
      expect(isMaskedValue({})).toBe(false);
      expect(isMaskedValue([])).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isMaskedValue("")).toBe(false);
    });
  });
});

describe("isFullyMasked", () => {
  test("detects full masks", () => {
    expect(isFullyMasked("***")).toBe(true);
    expect(isFullyMasked("******")).toBe(true);
  });

  test("rejects partial masks", () => {
    expect(isFullyMasked("J***n")).toBe(false);
    expect(isFullyMasked("****5678")).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isFullyMasked(null)).toBe(false);
    expect(isFullyMasked(42)).toBe(false);
  });
});
