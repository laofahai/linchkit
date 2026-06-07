/**
 * Tests for ProposalValidationFindings helpers (Spec 09 §4.5 — compatibility).
 *
 * The component itself is JSX-only — we test the pure data-shaping helpers
 * since the package's test setup is logic-only (no happy-dom / jsdom). The
 * helpers cover every branch the component renders:
 *   - selecting non-skipped phases that carry findings
 *   - sorting the compatibility phase (Phase 3) first
 *   - counting errors / warnings defensively across phases
 *   - tolerating null / undefined / partial / malformed results without crashing
 */

import { describe, expect, test } from "bun:test";
import {
  COMPATIBILITY_PHASE,
  countFindings,
  hasAnyFindings,
  selectPhasesWithFindings,
} from "../src/components/proposal-validation-findings-helpers";
import type { ProposalValidationResult } from "../src/lib/proposal-api";

// ── Fixtures ────────────────────────────────────────────────

const compatWarnings: ProposalValidationResult = {
  passed: true,
  impactSummary: "",
  phases: [
    { phase: 1, status: "passed", errors: [], warnings: [], duration: 1 },
    {
      phase: 3,
      status: "passed",
      errors: [],
      warnings: [
        { code: "BREAKING_FIELD_DELETE", message: "field still referenced", field: "task.x" },
      ],
      duration: 5,
    },
  ],
};

const mixedPhases: ProposalValidationResult = {
  passed: false,
  impactSummary: "",
  phases: [
    {
      phase: 1,
      status: "failed",
      errors: [{ code: "SCHEMA_INVALID", message: "bad schema" }],
      warnings: [],
      duration: 2,
    },
    { phase: 2, status: "skipped", errors: [], warnings: [], duration: 0 },
    {
      phase: 3,
      status: "failed",
      errors: [{ code: "BREAKING_ELEMENT_DELETE", message: "action deleted" }],
      warnings: [{ code: "BREAKING_ENUM_VALUE_REMOVED", message: "enum removed" }],
      duration: 9,
    },
    { phase: 4, status: "passed", errors: [], warnings: [], duration: 1 },
  ],
};

// ── COMPATIBILITY_PHASE constant ────────────────────────────

describe("COMPATIBILITY_PHASE", () => {
  test("is phase 3 (Spec 09 §4.5)", () => {
    expect(COMPATIBILITY_PHASE).toBe(3);
  });
});

// ── selectPhasesWithFindings ────────────────────────────────

describe("selectPhasesWithFindings", () => {
  test("null result → empty (defensive)", () => {
    expect(selectPhasesWithFindings(null)).toEqual([]);
  });

  test("undefined result → empty (defensive)", () => {
    expect(selectPhasesWithFindings(undefined)).toEqual([]);
  });

  test("result with no phases array → empty (defensive)", () => {
    expect(
      selectPhasesWithFindings({ passed: true, impactSummary: "", phases: undefined as never }),
    ).toEqual([]);
  });

  test("excludes skipped phases", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      phases: [
        {
          phase: 3,
          status: "skipped",
          errors: [{ code: "X", message: "y" }],
          warnings: [],
          duration: 0,
        },
      ],
    };
    expect(selectPhasesWithFindings(result)).toEqual([]);
  });

  test("excludes non-skipped phases with zero findings (clean pass)", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      phases: [{ phase: 1, status: "passed", errors: [], warnings: [], duration: 1 }],
    };
    expect(selectPhasesWithFindings(result)).toEqual([]);
  });

  test("includes a phase that has warnings only", () => {
    const selected = selectPhasesWithFindings(compatWarnings);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.phase).toBe(3);
    expect(selected[0]?.isCompatibility).toBe(true);
    expect(selected[0]?.warnings).toHaveLength(1);
    expect(selected[0]?.errors).toHaveLength(0);
  });

  test("sorts the compatibility phase (3) first, then ascending", () => {
    const selected = selectPhasesWithFindings(mixedPhases);
    // phase 2 skipped → excluded; phase 4 clean → excluded.
    expect(selected.map((p) => p.phase)).toEqual([3, 1]);
    expect(selected[0]?.isCompatibility).toBe(true);
    expect(selected[1]?.isCompatibility).toBe(false);
  });

  test("tolerates a phase missing its errors/warnings arrays", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      // Malformed: errors/warnings omitted by an older producer.
      phases: [{ phase: 3, status: "passed", duration: 1 } as never],
    };
    // No findings → excluded, but does not throw.
    expect(selectPhasesWithFindings(result)).toEqual([]);
  });

  test("non-3 phase with findings is still included and not flagged compatibility", () => {
    const result: ProposalValidationResult = {
      passed: false,
      impactSummary: "",
      phases: [
        {
          phase: 1,
          status: "failed",
          errors: [{ code: "E", message: "m" }],
          warnings: [],
          duration: 1,
        },
      ],
    };
    const selected = selectPhasesWithFindings(result);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.phase).toBe(1);
    expect(selected[0]?.isCompatibility).toBe(false);
  });
});

// ── countFindings ───────────────────────────────────────────

describe("countFindings", () => {
  test("null result → zeros (defensive)", () => {
    expect(countFindings(null)).toEqual({ errors: 0, warnings: 0 });
  });

  test("undefined result → zeros (defensive)", () => {
    expect(countFindings(undefined)).toEqual({ errors: 0, warnings: 0 });
  });

  test("counts errors and warnings across non-skipped phases", () => {
    expect(countFindings(mixedPhases)).toEqual({ errors: 2, warnings: 1 });
  });

  test("skipped phase findings are not counted", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      phases: [
        {
          phase: 3,
          status: "skipped",
          errors: [{ code: "X", message: "y" }],
          warnings: [{ code: "W", message: "z" }],
          duration: 0,
        },
      ],
    };
    expect(countFindings(result)).toEqual({ errors: 0, warnings: 0 });
  });

  test("tolerates missing errors/warnings arrays", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      phases: [{ phase: 3, status: "passed", duration: 1 } as never],
    };
    expect(countFindings(result)).toEqual({ errors: 0, warnings: 0 });
  });
});

// ── hasAnyFindings ──────────────────────────────────────────

describe("hasAnyFindings", () => {
  test("false for null / undefined", () => {
    expect(hasAnyFindings(null)).toBe(false);
    expect(hasAnyFindings(undefined)).toBe(false);
  });

  test("false for a clean pass", () => {
    const result: ProposalValidationResult = {
      passed: true,
      impactSummary: "",
      phases: [{ phase: 1, status: "passed", errors: [], warnings: [], duration: 1 }],
    };
    expect(hasAnyFindings(result)).toBe(false);
  });

  test("true when warnings exist", () => {
    expect(hasAnyFindings(compatWarnings)).toBe(true);
  });

  test("true when errors exist", () => {
    expect(hasAnyFindings(mixedPhases)).toBe(true);
  });
});
