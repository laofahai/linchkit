import { describe, expect, test } from "bun:test";
import { validatePhase4 } from "../../engine/validation-phase4";
import type { ProposalChange } from "../../types/proposal";

function change(overrides: Partial<ProposalChange>): ProposalChange {
  return { target: "action", operation: "create", name: "do_thing", ...overrides };
}

const GOOD = `import { defineAction } from "@linchkit/core";
export const do_thing = defineAction({ name: "do_thing", handler: async () => ({}) });`;

describe("validatePhase4 — generated-source contract", () => {
  test("skips when no change carries generatedSource", () => {
    const result = validatePhase4({
      changes: [change({}), change({ target: "rule", name: "r1" })],
    });
    expect(result.phase).toBe(4);
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("skips an empty / whitespace generatedSource (a Phase 2 concern, not re-flagged)", () => {
    const result = validatePhase4({
      changes: [change({ name: "empty_action", generatedSource: "   \n" })],
    });
    expect(result.status).toBe("skipped");
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("passes a well-formed action definition", () => {
    const result = validatePhase4({
      changes: [change({ generatedSource: GOOD })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warn-only by default: missing defineAction() → warning, status stays passed", () => {
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          // syntactically fine, references the name + imports core, but no defineAction()
          generatedSource: `import { x } from "@linchkit/core";\nexport const do_thing = 1;`,
        }),
      ],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("GENERATED_SOURCE_CONTRACT");
    expect(result.warnings[0]?.message).toContain("defineAction");
    expect(result.warnings[0]?.target).toBe("do_thing");
  });

  test("flags a missing name reference and a missing core import", () => {
    const result = validatePhase4({
      changes: [
        change({
          name: "deduct_inventory",
          // calls defineAction but neither references the declared name nor imports core
          generatedSource: `export const other = defineAction({ name: "other", handler: async () => ({}) });`,
        }),
      ],
    });
    expect(result.status).toBe("passed"); // warn-only
    const codes = result.warnings.map((w) => w.message);
    expect(
      codes.some((m) => m.includes('does not reference its declared name "deduct_inventory"')),
    ).toBe(true);
    expect(codes.some((m) => m.includes('does not import from "@linchkit/core"'))).toBe(true);
  });

  test("comment markers INSIDE string literals are not treated as comments (URL / slash safety)", () => {
    // `/*` in one string and `*/` in another must NOT be parsed as a block
    // comment that swallows the real import/defineAction between them — and a URL's
    // `//` must not be parsed as a line comment. A naive regex stripper fails this;
    // the single-pass string-aware walker passes it (gemini review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "sync_data",
          generatedSource: [
            'const open = "/*";',
            'import { defineAction } from "@linchkit/core";',
            'const url = "https://api.example.com/v1";',
            'export const sync_data = defineAction({ name: "sync_data", handler: async () => ({ url }) });',
            'const close = "*/";',
          ].join("\n"),
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
  });

  test("a re-export from core does NOT satisfy the import check (no local binding)", () => {
    // `export { defineAction } from "@linchkit/core"` re-exports — it creates no
    // local `defineAction` binding, so calling it would fail. The import check
    // must require a real `import` (codex review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `export { defineAction } from "@linchkit/core";\nexport const do_thing = defineAction({ name: "do_thing", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) => e.message.includes('does not import from "@linchkit/core"')),
    ).toBe(true);
  });

  test("tokens that appear only in comments or strings do NOT satisfy the contract", () => {
    // defineAction( and @linchkit/core appear ONLY inside a comment / string —
    // they must not satisfy the call/import checks (codex review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: [
            '// import { defineAction } from "@linchkit/core";',
            "/* defineAction( should not count */",
            'const note = "use defineAction() from @linchkit/core";',
            "export const do_thing = 1;",
          ].join("\n"),
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    const msgs = result.errors.map((e) => e.message);
    // Both the call check and the import check must fire despite the mentions.
    expect(msgs.some((m) => m.includes("does not call defineAction(...)"))).toBe(true);
    expect(msgs.some((m) => m.includes('does not import from "@linchkit/core"'))).toBe(true);
  });

  test("a different name that merely CONTAINS the declared name does not satisfy it", () => {
    // Declared "do_thing" but the source defines "do_thing_v2" — substring would
    // pass, word-boundary must not (codex review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineAction } from "@linchkit/core";\nexport const do_thing_v2 = defineAction({ name: "do_thing_v2", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not reference its declared name "do_thing"'),
      ),
    ).toBe(true);
  });

  test("strictGeneratedContract: findings become errors, status failed", () => {
    const result = validatePhase4({
      changes: [change({ name: "do_thing", generatedSource: `export const do_thing = 1;` })],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("GENERATED_SOURCE_CONTRACT");
  });
});
