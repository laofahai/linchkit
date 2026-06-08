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
          // imports defineAction (so the import check is satisfied) but never calls
          // it — isolates the missing-define finding.
          generatedSource: `import { defineAction } from "@linchkit/core";\nexport const do_thing = 1;`,
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

  test("flags defining the wrong action + a missing core import", () => {
    const result = validatePhase4({
      changes: [
        change({
          name: "deduct_inventory",
          // calls defineAction for a DIFFERENT action and does not import core
          generatedSource: `export const other = defineAction({ name: "other", handler: async () => ({}) });`,
        }),
      ],
    });
    expect(result.status).toBe("passed"); // warn-only
    const codes = result.warnings.map((w) => w.message);
    expect(
      codes.some((m) => m.includes('does not define defineAction(...) for "deduct_inventory"')),
    ).toBe(true);
    expect(
      codes.some((m) => m.includes('does not import defineAction from "@linchkit/core"')),
    ).toBe(true);
  });

  test("defineAction for ANOTHER action does not satisfy the declared name (tied check)", () => {
    // A real defineAction call + the declared name mentioned elsewhere must NOT
    // pass: the call must be tied to the declared action (codex review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineAction } from "@linchkit/core";\nexport const do_thing = 1;\nexport const other = defineAction({ name: "other", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not define defineAction(...) for "do_thing"'),
      ),
    ).toBe(true);
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

  test("an import that appears only inside a string literal does NOT satisfy the import check", () => {
    // The full import statement lives inside a string; defineAction is called as
    // real code but there is NO real import binding → must flag missing import
    // (codex review hardening — string-aware import detection).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: [
            'const fake = "import { defineAction } from \\"@linchkit/core\\";";',
            'export const do_thing = defineAction({ name: "do_thing", handler: async () => ({ fake }) });',
          ].join("\n"),
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not import defineAction from "@linchkit/core"'),
      ),
    ).toBe(true);
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
      result.errors.some((e) =>
        e.message.includes('does not import defineAction from "@linchkit/core"'),
      ),
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
    // Both the define check and the import check must fire despite the mentions.
    expect(msgs.some((m) => m.includes("does not define defineAction(...)"))).toBe(true);
    expect(msgs.some((m) => m.includes('does not import defineAction from "@linchkit/core"'))).toBe(
      true,
    );
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
        e.message.includes('does not define defineAction(...) for "do_thing"'),
      ),
    ).toBe(true);
  });

  test("importing a DIFFERENT core helper does not satisfy the import check", () => {
    // defineEntity is imported, but the source calls defineAction → the helper it
    // calls is not bound (codex review hardening — helper-specific import).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineEntity } from "@linchkit/core";\nexport const do_thing = defineAction({ name: "do_thing", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not import defineAction from "@linchkit/core"'),
      ),
    ).toBe(true);
  });

  test("a name: in unrelated code after the call does not satisfy the tied check", () => {
    // defineAction defines "other"; the declared name appears only in a separate
    // object literal → the name match must stay inside the call's own braces
    // (codex review hardening).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineAction } from "@linchkit/core";\nexport const other = defineAction({ name: "other", handler: async () => ({}) });\nconst metadata = { name: "do_thing" };`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not define defineAction(...) for "do_thing"'),
      ),
    ).toBe(true);
  });

  test("the OPTIONS name: is authoritative — a matching variable name does not save a wrong name:", () => {
    // `const do_thing = defineAction({ name: "other" })` registers action "other"
    // (the options name:), not "do_thing" (the variable). Must flag (codex review).
    const result = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineAction } from "@linchkit/core";\nexport const do_thing = defineAction({ name: "other", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(
      result.errors.some((e) =>
        e.message.includes('does not define defineAction(...) for "do_thing"'),
      ),
    ).toBe(true);
  });

  test("a type-only or aliased helper import does not satisfy the import check", () => {
    // `import type { defineAction }` is erased; `defineAction as da` binds `da`,
    // not `defineAction` — neither gives a usable defineAction value (codex review).
    const typeOnly = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import type { defineAction } from "@linchkit/core";\nexport const do_thing = defineAction({ name: "do_thing", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(typeOnly.status).toBe("failed");
    expect(
      typeOnly.errors.some((e) =>
        e.message.includes('does not import defineAction from "@linchkit/core"'),
      ),
    ).toBe(true);

    const aliased = validatePhase4({
      changes: [
        change({
          name: "do_thing",
          generatedSource: `import { defineAction as da } from "@linchkit/core";\nexport const do_thing = da({ name: "do_thing", handler: async () => ({}) });`,
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(aliased.status).toBe("failed");
    expect(
      aliased.errors.some((e) =>
        e.message.includes('does not import defineAction from "@linchkit/core"'),
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

  test("a FAILED materialization (no source) is flagged warn-only by default, NOT skipped", () => {
    const result = validatePhase4({
      changes: [
        change({
          name: "deduct_inventory",
          materializationStatus: "failed",
          materializationErrors: ["syntax error: unexpected token at line 3"],
          // no generatedSource — cleared on failure
        }),
      ],
    });
    expect(result.status).toBe("passed"); // warn-only, NOT "skipped"
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("GENERATED_SOURCE_FAILED");
    expect(result.warnings[0]?.message).toContain("deduct_inventory");
    expect(result.warnings[0]?.message).toContain("syntax error: unexpected token at line 3");
    expect(result.warnings[0]?.target).toBe("deduct_inventory");
  });

  test("a FAILED materialization under strictGeneratedContract becomes a blocking error", () => {
    const result = validatePhase4({
      changes: [
        change({
          name: "deduct_inventory",
          materializationStatus: "failed",
          materializationErrors: ["syntax error: unexpected token at line 3"],
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe("GENERATED_SOURCE_FAILED");
    expect(result.errors[0]?.message).toContain("deduct_inventory");
  });

  test("a FAILED materialization with no error detail still flags (no crash)", () => {
    const result = validatePhase4({
      changes: [change({ name: "deduct_inventory", materializationStatus: "failed" })],
    });
    expect(result.status).toBe("passed");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("GENERATED_SOURCE_FAILED");
    // no "Build-gate errors:" detail when there are no errors
    expect(result.warnings[0]?.message).not.toContain("Build-gate errors");
  });

  test("a very long error list is capped to a reasonable length with an ellipsis", () => {
    const longError = "x".repeat(500);
    const result = validatePhase4({
      changes: [
        change({
          name: "deduct_inventory",
          materializationStatus: "failed",
          materializationErrors: [longError],
        }),
      ],
    });
    expect(result.status).toBe("passed");
    const msg = result.warnings[0]?.message ?? "";
    expect(msg).toContain("...");
    // the capped detail must not contain the full 500-char error verbatim
    expect(msg).not.toContain(longError);
  });

  test("declarative-only changes (no source, no failed status) still skip (unchanged)", () => {
    const result = validatePhase4({
      changes: [change({}), change({ target: "rule", name: "r1" })],
    });
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a NON-materializable change carrying a stale 'failed' status is NOT flagged (aligned with isMaterializable)", () => {
    // The change was an action that failed generation (so it carries
    // materializationStatus:"failed"), then was edited to a declarative target
    // without re-materializing. It is no longer materializable, so Phase 4 must
    // not treat it as a failed code generation — reporting it (and blocking
    // under strict) would be wrong. The failed-filter is guarded by
    // isMaterializable, so this degrades to "skipped". (Regression for codex on
    // the Phase 4 PR.)
    const result = validatePhase4({
      changes: [
        change({
          target: "entity",
          name: "invoice",
          materializationStatus: "failed",
          materializationErrors: ["stale build-gate error"],
        }),
      ],
    });
    expect(result.status).toBe("skipped");
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("a NON-materializable change with a stale 'failed' status does NOT block under strict", () => {
    const result = validatePhase4({
      changes: [
        change({
          target: "entity",
          name: "invoice",
          materializationStatus: "failed",
          materializationErrors: ["stale build-gate error"],
        }),
      ],
      strictGeneratedContract: true,
    });
    // No materializable failure → nothing to escalate → not blocking.
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
  });

  test("mix: one good source + one failed change → non-strict passes with exactly one FAILED warning", () => {
    const result = validatePhase4({
      changes: [
        change({ name: "do_thing", generatedSource: GOOD }),
        change({
          name: "deduct_inventory",
          materializationStatus: "failed",
          materializationErrors: ["build gate rejected: missing handler"],
        }),
      ],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    const failedWarnings = result.warnings.filter((w) => w.code === "GENERATED_SOURCE_FAILED");
    expect(failedWarnings.length).toBe(1);
    expect(failedWarnings[0]?.target).toBe("deduct_inventory");
    // the good source produces no contract finding
    expect(result.warnings.filter((w) => w.code === "GENERATED_SOURCE_CONTRACT")).toEqual([]);
  });

  test("mix: one good source + one failed change → strict fails on the failed change", () => {
    const result = validatePhase4({
      changes: [
        change({ name: "do_thing", generatedSource: GOOD }),
        change({
          name: "deduct_inventory",
          materializationStatus: "failed",
          materializationErrors: ["build gate rejected: missing handler"],
        }),
      ],
      strictGeneratedContract: true,
    });
    expect(result.status).toBe("failed");
    const failedErrors = result.errors.filter((e) => e.code === "GENERATED_SOURCE_FAILED");
    expect(failedErrors.length).toBe(1);
    expect(failedErrors[0]?.target).toBe("deduct_inventory");
  });
});
