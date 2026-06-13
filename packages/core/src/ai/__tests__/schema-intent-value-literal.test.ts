/**
 * Tests for `isSafeValueLiteral` (#566 — the security gate for `newValueLiteral`).
 *
 * `newValueLiteral` is spliced VERBATIM into capability source code by the
 * graduation patcher, so it must accept ONLY a self-contained value literal and
 * REJECT anything that could execute or inject. These tests pin both the safe
 * surface (numbers / booleans / null / double-quoted JSON strings) and a battery
 * of malicious / malformed inputs.
 */

import { describe, expect, it } from "bun:test";
import { isSafeValueLiteral, parseSchemaIntentResponse } from "../schema-intent-prompt";

describe("isSafeValueLiteral — accepts safe value literals", () => {
  const safe = [
    "20000",
    "0",
    "-1",
    "+42",
    "-1.5",
    "3.14",
    ".5",
    "42.",
    "true",
    "false",
    "null",
    '"manager"',
    '""',
    '"a string with spaces"',
    '"中文"',
    '"escaped \\" quote"',
  ];
  for (const value of safe) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(isSafeValueLiteral(value)).toBe(true);
    });
  }
});

describe("isSafeValueLiteral — rejects unsafe / malformed input", () => {
  const unsafe = [
    // The exact attack strings called out by the spec.
    "foo()",
    "1;DROP",
    "`x`",
    "() => 9",
    // Identifiers / globals masquerading as literals.
    "MANAGER_APPROVAL_THRESHOLD",
    "Infinity",
    "NaN",
    "undefined",
    "process",
    // Operators / expressions.
    "1 + 1",
    "20000 || true",
    "a && b",
    "x = 9",
    // Statements / separators / comments.
    "1; alert(1)",
    "1, 2",
    "1 // comment",
    "1 /* c */",
    // Object / array literals (not a single value literal).
    "{}",
    "[]",
    "{ a: 1 }",
    "[1, 2, 3]",
    // Template / single-quoted / unterminated strings.
    "'manager'",
    '"unterminated',
    'unterminated"',
    '"a" + "b"',
    '"a", "b"',
    // Whitespace-wrapped multi-token (must not pass via a sloppy trim).
    " 1 ; DROP ",
    "  20000  ",
    // Malformed numbers.
    "0x1F",
    "1e3",
    "1_000",
    // Leading zeros splice in as an octal literal → strict-mode TS syntax error.
    "007",
    "0123",
    "00",
    "",
    ".",
    "-",
    "+",
    "1.2.3",
  ];
  for (const value of unsafe) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(isSafeValueLiteral(value)).toBe(false);
    });
  }

  it("rejects a non-string input", () => {
    // Defensive runtime guard — callers should pass strings, but a malformed
    // payload must not slip through.
    expect(isSafeValueLiteral(20000 as unknown as string)).toBe(false);
    expect(isSafeValueLiteral(null as unknown as string)).toBe(false);
  });
});

describe("parseSchemaIntentResponse — newValueLiteral gating (#566)", () => {
  it("reads a SAFE newValueLiteral into the parsed intent", () => {
    const parsed = parseSchemaIntentResponse(
      JSON.stringify({
        kind: "update_rule",
        ruleName: "manager_approval_threshold",
        diff: "Raise the threshold to 20000.",
        newValueLiteral: "20000",
        confidence: 0.9,
      }),
    );
    expect(parsed?.newValueLiteral).toBe("20000");
  });

  it("DROPS an unsafe newValueLiteral (treated as absent)", () => {
    const parsed = parseSchemaIntentResponse(
      JSON.stringify({
        kind: "update_rule",
        ruleName: "manager_approval_threshold",
        diff: "Raise the threshold.",
        newValueLiteral: "foo(); DROP TABLE rules",
        confidence: 0.9,
      }),
    );
    expect(parsed?.newValueLiteral).toBeUndefined();
  });

  it("leaves newValueLiteral undefined when omitted", () => {
    const parsed = parseSchemaIntentResponse(
      JSON.stringify({
        kind: "update_rule",
        ruleName: "manager_approval_threshold",
        diff: "Raise the threshold.",
        confidence: 0.9,
      }),
    );
    expect(parsed?.newValueLiteral).toBeUndefined();
  });
});
