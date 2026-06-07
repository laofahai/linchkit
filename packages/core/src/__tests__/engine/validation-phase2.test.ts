import { describe, expect, test } from "bun:test";
import { validatePhase2 } from "../../engine/validation-phase2";
import type { ProposalChange } from "../../types/proposal";

function change(overrides: Partial<ProposalChange>): ProposalChange {
  return { target: "action", operation: "create", name: "do_thing", ...overrides };
}

describe("validatePhase2", () => {
  test("skips when no change carries generatedSource", () => {
    const result = validatePhase2({
      changes: [change({}), change({ target: "rule", name: "r1" })],
    });
    expect(result.phase).toBe(2);
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("passes when generated source is syntactically valid", () => {
    const result = validatePhase2({
      changes: [change({ generatedSource: "export const x = 1;" })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warn-only by default: bad source → warnings, status stays passed", () => {
    const result = validatePhase2({
      changes: [change({ name: "broken", generatedSource: "export const a = {" })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.code).toBe("GENERATED_SOURCE_SYNTAX");
    expect(result.warnings[0]?.target).toBe("broken");
  });

  test("strictGeneratedBuild: bad source → errors, status failed", () => {
    const result = validatePhase2({
      changes: [change({ name: "broken", generatedSource: "export const a = {" })],
      strictGeneratedBuild: true,
    });
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe("GENERATED_SOURCE_SYNTAX");
  });
});
