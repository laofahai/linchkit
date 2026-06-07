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
