import { describe, expect, it } from "bun:test";
import type { SourcePatcher } from "@linchkit/core";
import { patchNamedConstant } from "../src/patch-named-constant";

// Compile-time guard: the implementation must conform to core's injected
// SourcePatcher contract. If the signature drifts, typecheck fails here.
const _patcher: SourcePatcher = patchNamedConstant;
void _patcher;

describe("patchNamedConstant", () => {
  // (1) basic numeric replace + rest of file byte-identical
  it("replaces a numeric initializer and leaves every other byte intact", () => {
    const source = "export const A = 1;\nexport const B = 2;\n";
    const result = patchNamedConstant({
      source,
      constantName: "A",
      newValueLiteral: "42",
    });
    expect(result.changed).toBe(true);
    expect(result.oldValueLiteral).toBe("1");
    expect(result.source).toBe("export const A = 42;\nexport const B = 2;\n");
  });

  // (2) `: number` type annotation preserved
  it("preserves a `: number` type annotation", () => {
    const source = "export const COUNT: number = 5;\n";
    const result = patchNamedConstant({
      source,
      constantName: "COUNT",
      newValueLiteral: "10",
    });
    expect(result.changed).toBe(true);
    expect(result.oldValueLiteral).toBe("5");
    expect(result.source).toBe("export const COUNT: number = 10;\n");
  });

  // (3) trailing comment + indentation preserved
  it("preserves indentation and a trailing comment", () => {
    const source = "  export const X = 100; // threshold\n";
    const result = patchNamedConstant({
      source,
      constantName: "X",
      newValueLiteral: "200",
    });
    expect(result.changed).toBe(true);
    expect(result.oldValueLiteral).toBe("100");
    expect(result.source).toBe("  export const X = 200; // threshold\n");
  });

  // (4) no substring match (`X` must not match `X_2`)
  it("does not match a substring-named constant", () => {
    const source = "export const X_2 = 7;\n";
    expect(() => patchNamedConstant({ source, constantName: "X", newValueLiteral: "9" })).toThrow(
      /NOT FOUND/,
    );
  });

  // (5) no match inside a comment or string literal
  it("does not match the name inside a comment or string literal", () => {
    const source = '// export const SECRET = 1;\nexport const note = "export const SECRET = 2";\n';
    expect(() =>
      patchNamedConstant({ source, constantName: "SECRET", newValueLiteral: "3" }),
    ).toThrow(/NOT FOUND/);
  });

  // (6) idempotent: newValue already equals current → changed: false, source unchanged
  it("is idempotent when the value already equals the target", () => {
    const source = "export const A = 42;\n";
    const result = patchNamedConstant({
      source,
      constantName: "A",
      newValueLiteral: "42",
    });
    expect(result.changed).toBe(false);
    expect(result.oldValueLiteral).toBe("42");
    expect(result.source).toBe(source);
  });

  // (7) non-exported const → throws NOT FOUND
  it("throws NOT FOUND for a non-exported const", () => {
    const source = "const A = 1;\n";
    expect(() => patchNamedConstant({ source, constantName: "A", newValueLiteral: "2" })).toThrow(
      /NOT FOUND/,
    );
  });

  // (8) nested / in-function const → throws NOT FOUND (top-level walk only)
  it("throws NOT FOUND for a const declared inside a function", () => {
    const source = "export function f() {\n  const A = 1;\n  return A;\n}\n";
    expect(() => patchNamedConstant({ source, constantName: "A", newValueLiteral: "2" })).toThrow(
      /NOT FOUND/,
    );
  });

  // (8a) `export let` is a mutable binding → NOT a const → throws NOT FOUND
  it("throws NOT FOUND for an export let (const-only contract)", () => {
    const source = "export let X = 1;\n";
    expect(() => patchNamedConstant({ source, constantName: "X", newValueLiteral: "3" })).toThrow(
      /NOT FOUND/,
    );
  });

  // (8b) `export var` is a mutable binding → NOT a const → throws NOT FOUND
  it("throws NOT FOUND for an export var (const-only contract)", () => {
    const source = "export var X = 1;\n";
    expect(() => patchNamedConstant({ source, constantName: "X", newValueLiteral: "3" })).toThrow(
      /NOT FOUND/,
    );
  });

  // (9) ambiguous: two top-level `export const X` → throws AMBIGUOUS
  it("throws AMBIGUOUS when two top-level export consts share the name", () => {
    const source = "export const X = 1;\nexport const X = 2;\n";
    expect(() => patchNamedConstant({ source, constantName: "X", newValueLiteral: "3" })).toThrow(
      /AMBIGUOUS/,
    );
  });

  // (10) `export declare const X: number;` (no initializer) → throws NO INITIALIZER
  it("throws NO INITIALIZER for a declare const without an initializer", () => {
    const source = "export declare const X: number;\n";
    expect(() => patchNamedConstant({ source, constantName: "X", newValueLiteral: "5" })).toThrow(
      /NO INITIALIZER/,
    );
  });

  // (11) realistic module: patch the threshold; consuming function body untouched
  it("patches a threshold constant in a realistic module without touching the function", () => {
    const source = [
      "/**",
      " * Approval policy for purchase requests.",
      " */",
      "export const MANAGER_APPROVAL_THRESHOLD = 10000;",
      "",
      "export function requiresManagerApproval(amount: number): boolean {",
      "  // amounts at or above MANAGER_APPROVAL_THRESHOLD need sign-off",
      "  return amount >= MANAGER_APPROVAL_THRESHOLD;",
      "}",
      "",
    ].join("\n");

    const result = patchNamedConstant({
      source,
      constantName: "MANAGER_APPROVAL_THRESHOLD",
      newValueLiteral: "20000",
    });

    expect(result.changed).toBe(true);
    expect(result.oldValueLiteral).toBe("10000");
    expect(result.source).toContain("export const MANAGER_APPROVAL_THRESHOLD = 20000;");
    // The function body (which references the name) must be byte-for-byte intact.
    expect(result.source).toContain("  return amount >= MANAGER_APPROVAL_THRESHOLD;");
    expect(result.source).toContain(
      "  // amounts at or above MANAGER_APPROVAL_THRESHOLD need sign-off",
    );
    // Exactly one numeric literal changed: only the threshold declaration.
    expect(result.source).toBe(source.replace("= 10000;", "= 20000;"));
  });
});
