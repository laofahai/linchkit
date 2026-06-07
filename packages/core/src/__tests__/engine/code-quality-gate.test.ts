import { describe, expect, test } from "bun:test";
import { checkSourceSyntax, createSyntaxQualityGate } from "../../engine/code-quality-gate";

describe("checkSourceSyntax", () => {
  test("returns no errors for syntactically valid TypeScript", () => {
    const errors = checkSourceSyntax(
      "export const x: number = 1;\nexport function f(a: string): string { return a; }",
    );
    expect(errors).toEqual([]);
  });

  test("reports a syntax error for malformed source", () => {
    const errors = checkSourceSyntax("export const a = {\n"); // unbalanced brace
    expect(errors.length).toBeGreaterThan(0);
  });

  test("flags empty / whitespace-only source", () => {
    expect(checkSourceSyntax("")).toEqual(["Generated source is empty."]);
    expect(checkSourceSyntax("   \n\t")).toEqual(["Generated source is empty."]);
  });

  test("accepts tsx via filename loader", () => {
    const errors = checkSourceSyntax("export const E = () => <div>hi</div>;", "comp.tsx");
    expect(errors).toEqual([]);
  });
});

describe("createSyntaxQualityGate", () => {
  test("aggregates errors across files, prefixed with the path", async () => {
    const gate = createSyntaxQualityGate();
    const errors = await gate.check({
      "ok.ts": "export const x = 1;",
      "bad.ts": "export const a = {",
    });
    expect(errors.some((e) => e.startsWith("bad.ts: "))).toBe(true);
    expect(errors.some((e) => e.startsWith("ok.ts: "))).toBe(false);
  });

  test("returns no errors when every file is valid", async () => {
    const gate = createSyntaxQualityGate();
    const errors = await gate.check({
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
    });
    expect(errors).toEqual([]);
  });
});
