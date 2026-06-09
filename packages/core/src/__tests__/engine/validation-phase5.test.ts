import { describe, expect, test } from "bun:test";
import { validatePhase5 } from "../../engine/validation-phase5";
import type { ProposalChange } from "../../types/proposal";

function change(overrides: Partial<ProposalChange>): ProposalChange {
  // A materializable change is an action create/update (mirrors the Phase 4 test).
  return { target: "action", operation: "create", name: "do_thing", ...overrides };
}

describe("validatePhase5 — execution dry-run signal", () => {
  test("skips when no change carries a dryRunStatus", () => {
    const result = validatePhase5({
      changes: [change({}), change({ target: "rule", name: "r1" })],
    });
    expect(result.phase).toBe(5);
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a passed dry-run produces no finding and the phase passes", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "passed" })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a skipped dry-run on a materializable change produces no finding and passes", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "skipped" })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a threw dry-run is warn-only by default: warning, status stays passed", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "threw" })],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
    expect(result.warnings[0]?.message).toContain("do_thing");
    expect(result.warnings[0]?.message).toContain("threw");
    expect(result.warnings[0]?.target).toBe("do_thing");
  });

  test("a threw dry-run under strictExecutionDryRun becomes a blocking error", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "threw" })],
      strictExecutionDryRun: true,
    });
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
    expect(result.errors[0]?.message).toContain("do_thing");
    expect(result.errors[0]?.target).toBe("do_thing");
  });

  test("every content-failure status is reported (timeout/oom/forbidden_side_effect/malformed_output)", () => {
    for (const status of ["timeout", "oom", "forbidden_side_effect", "malformed_output"] as const) {
      const result = validatePhase5({
        changes: [change({ name: "do_thing", dryRunStatus: status })],
        strictExecutionDryRun: true,
      });
      expect(result.status).toBe("failed");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
      expect(result.errors[0]?.message).toContain(status);
    }
  });

  test("infra_error is ALWAYS a warning, even under strictExecutionDryRun (never blocks)", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "infra_error" })],
      strictExecutionDryRun: true,
    });
    expect(result.status).toBe("passed"); // never blocks
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_INFRA");
    expect(result.warnings[0]?.message).toContain("do_thing");
    expect(result.warnings[0]?.target).toBe("do_thing");
  });

  test("a NON-materializable change carrying a stray dryRunStatus is ignored → skipped", () => {
    // An entity is not materializable; a stale dryRunStatus on it (e.g. edited
    // from action→entity without re-running) must not be treated as a real
    // dry-run result. Guarded by isMaterializable, so the phase degrades to
    // "skipped" — and does NOT block even under strict.
    const result = validatePhase5({
      changes: [change({ target: "entity", name: "invoice", dryRunStatus: "threw" })],
      strictExecutionDryRun: true,
    });
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a delete operation is not materializable → a stray dryRunStatus is ignored", () => {
    const result = validatePhase5({
      changes: [change({ operation: "delete", name: "do_thing", dryRunStatus: "threw" })],
      strictExecutionDryRun: true,
    });
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("the first outcome's error is surfaced in the finding message", () => {
    const result = validatePhase5({
      changes: [
        change({
          name: "do_thing",
          dryRunStatus: "threw",
          dryRunOutcomes: [
            {
              changeName: "do_thing",
              target: "action",
              status: "threw",
              error: "TypeError: cannot read 'id' of undefined",
              inputCaseId: "case-1",
            },
          ],
        }),
      ],
    });
    expect(result.status).toBe("passed");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.message).toContain("TypeError: cannot read 'id' of undefined");
  });

  test("a forbidden side-effect detail is surfaced when no error is present", () => {
    const result = validatePhase5({
      changes: [
        change({
          name: "do_thing",
          dryRunStatus: "forbidden_side_effect",
          dryRunOutcomes: [
            {
              changeName: "do_thing",
              target: "action",
              status: "forbidden_side_effect",
              attemptedSideEffects: [{ kind: "db_write", detail: "store.create('order', …)" }],
              inputCaseId: "case-1",
            },
          ],
        }),
      ],
    });
    expect(result.status).toBe("passed");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.message).toContain("store.create('order', …)");
  });

  test("a long outcome detail is capped with an ellipsis", () => {
    const longError = "x".repeat(500);
    const result = validatePhase5({
      changes: [
        change({
          name: "do_thing",
          dryRunStatus: "threw",
          dryRunOutcomes: [
            { changeName: "do_thing", target: "action", status: "threw", error: longError },
          ],
        }),
      ],
    });
    expect(result.status).toBe("passed");
    const msg = result.warnings[0]?.message ?? "";
    expect(msg).toContain("...");
    expect(msg).not.toContain(longError);
  });

  test("a content failure with no outcome detail still flags (no Detail suffix, no crash)", () => {
    const result = validatePhase5({
      changes: [change({ name: "do_thing", dryRunStatus: "threw" })],
    });
    expect(result.status).toBe("passed");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.message).not.toContain("Detail:");
  });

  test("mix: one passed + one threw + one infra_error → non-strict passes with two warnings", () => {
    const result = validatePhase5({
      changes: [
        change({ name: "ok", dryRunStatus: "passed" }),
        change({ name: "bad", dryRunStatus: "threw" }),
        change({ name: "flaky", dryRunStatus: "infra_error" }),
      ],
    });
    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.some((w) => w.code === "EXECUTION_DRY_RUN_FAILED")).toBe(true);
    expect(result.warnings.some((w) => w.code === "EXECUTION_DRY_RUN_INFRA")).toBe(true);
  });

  test("mix: one threw + one infra_error under strict → fails on content, infra stays warning", () => {
    const result = validatePhase5({
      changes: [
        change({ name: "bad", dryRunStatus: "threw" }),
        change({ name: "flaky", dryRunStatus: "infra_error" }),
      ],
      strictExecutionDryRun: true,
    });
    expect(result.status).toBe("failed");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
    expect(result.errors[0]?.target).toBe("bad");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_INFRA");
    expect(result.warnings[0]?.target).toBe("flaky");
  });
});
