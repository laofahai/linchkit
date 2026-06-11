/**
 * Tests for the pure proposal-review helpers (status→badge + action predicates).
 *
 * These gate which action buttons the review page offers per proposal status,
 * so they are unit-tested independently of the React render.
 */

import { describe, expect, test } from "bun:test";

import {
  buildMaterializeScope,
  canGraduate,
  changeTypeBadgeClass,
  isPending,
  PROPOSAL_STATUS_FILTERS,
  selectDryRunChanges,
  selectFailedMaterializationChanges,
  selectSourcedChanges,
  statusBadgeClass,
} from "../src/pages/proposal-review-helpers";

describe("isPending", () => {
  test("draft / validating / validated are pending (approve+reject offered)", () => {
    expect(isPending("draft")).toBe(true);
    expect(isPending("validating")).toBe(true);
    expect(isPending("validated")).toBe(true);
  });

  test("approved / rejected / committed are NOT pending", () => {
    expect(isPending("approved")).toBe(false);
    expect(isPending("rejected")).toBe(false);
    expect(isPending("committed")).toBe(false);
  });

  test("an unknown status is not pending", () => {
    expect(isPending("nonsense")).toBe(false);
  });
});

describe("canGraduate", () => {
  test("only approved proposals can graduate", () => {
    expect(canGraduate("approved")).toBe(true);
  });

  test("non-approved statuses cannot graduate", () => {
    for (const status of ["draft", "validating", "validated", "rejected", "committed", "x"]) {
      expect(canGraduate(status)).toBe(false);
    }
  });

  test("a proposal is never both pending and graduatable", () => {
    for (const status of PROPOSAL_STATUS_FILTERS) {
      expect(isPending(status) && canGraduate(status)).toBe(false);
    }
  });
});

describe("statusBadgeClass", () => {
  test("returns a class for every known status", () => {
    for (const status of [
      "draft",
      "validating",
      "validated",
      "approved",
      "rejected",
      "committed",
    ]) {
      expect(statusBadgeClass(status).length).toBeGreaterThan(0);
    }
  });

  test("falls back to a default class for an unknown status", () => {
    expect(statusBadgeClass("???").length).toBeGreaterThan(0);
  });
});

describe("changeTypeBadgeClass", () => {
  test("returns a class for patch / minor / major", () => {
    expect(changeTypeBadgeClass("patch").length).toBeGreaterThan(0);
    expect(changeTypeBadgeClass("minor").length).toBeGreaterThan(0);
    expect(changeTypeBadgeClass("major").length).toBeGreaterThan(0);
  });

  test("returns an empty string for an unknown change type", () => {
    expect(changeTypeBadgeClass("???")).toBe("");
  });
});

describe("PROPOSAL_STATUS_FILTERS", () => {
  test("includes 'all' plus the six lifecycle statuses", () => {
    expect(PROPOSAL_STATUS_FILTERS).toEqual([
      "all",
      "draft",
      "validating",
      "validated",
      "approved",
      "rejected",
      "committed",
    ]);
  });
});

describe("selectSourcedChanges", () => {
  test("keeps changes whose generatedSource is a non-empty string", () => {
    const a = { name: "a", generatedSource: "export const x = 1;" };
    const b = { name: "b", generatedSource: "  " }; // whitespace only → dropped
    const c = { name: "c", generatedSource: "" }; // empty → dropped
    const d = { name: "d" }; // undefined → dropped
    const result = selectSourcedChanges([a, b, c, d]);
    expect(result).toEqual([a]);
  });

  test("returns an empty array when nothing is sourced", () => {
    expect(selectSourcedChanges([{ name: "x" }, { name: "y", generatedSource: "\t\n" }])).toEqual(
      [],
    );
  });

  test("returns an empty array for an empty input", () => {
    expect(selectSourcedChanges([])).toEqual([]);
  });
});

describe("selectFailedMaterializationChanges", () => {
  test("keeps only changes whose materializationStatus is 'failed'", () => {
    const failed = {
      name: "failed_action",
      materializationStatus: "failed",
      materializationErrors: ["TS1005: ';' expected", "Build gate rejected output"],
    };
    const ok = { name: "ok_action", materializationStatus: "materialized" };
    const none = { name: "declarative" }; // never materialized → dropped
    const result = selectFailedMaterializationChanges([failed, ok, none]);
    expect(result).toEqual([failed]);
  });

  test("the returned failed change carries its materializationErrors", () => {
    const errors = ["error one", "error two"];
    const [only] = selectFailedMaterializationChanges([
      { name: "f", materializationStatus: "failed", materializationErrors: errors },
    ]);
    expect(only?.materializationErrors).toEqual(errors);
  });

  test("returns an empty array when nothing failed", () => {
    expect(
      selectFailedMaterializationChanges([
        { name: "a", materializationStatus: "materialized" },
        { name: "b" },
      ]),
    ).toEqual([]);
  });
});

describe("selectDryRunChanges", () => {
  test("keeps changes with a non-skipped dryRunStatus", () => {
    const passed = { name: "a", dryRunStatus: "passed" };
    const threw = { name: "b", dryRunStatus: "threw" };
    const forbidden = { name: "c", dryRunStatus: "forbidden_side_effect" };
    const infra = { name: "d", dryRunStatus: "infra_error" };
    const result = selectDryRunChanges([passed, threw, forbidden, infra]);
    expect(result).toEqual([passed, threw, forbidden, infra]);
  });

  test("drops changes with dryRunStatus 'skipped'", () => {
    const skipped = { name: "a", dryRunStatus: "skipped" };
    const none = { name: "b" }; // undefined → no signal
    expect(selectDryRunChanges([skipped, none])).toEqual([]);
  });

  test("drops changes where dryRunStatus is undefined", () => {
    const noStatus = { name: "x" };
    expect(selectDryRunChanges([noStatus])).toEqual([]);
  });

  test("returns an empty array for an empty input", () => {
    expect(selectDryRunChanges([])).toEqual([]);
  });

  test("timeout and oom are surfaced (not skipped)", () => {
    const timeout = { name: "a", dryRunStatus: "timeout" };
    const oom = { name: "b", dryRunStatus: "oom" };
    expect(selectDryRunChanges([timeout, oom])).toEqual([timeout, oom]);
  });
});

describe("buildMaterializeScope", () => {
  test("scopes the materialize request to exactly the given change name", () => {
    expect(buildMaterializeScope("submit_request")).toEqual({
      changeNames: ["submit_request"],
    });
  });

  test("never widens the scope — always a single-element list", () => {
    const scope = buildMaterializeScope("approve_order");
    expect(scope.changeNames).toHaveLength(1);
    expect(scope.changeNames[0]).toBe("approve_order");
  });

  test("preserves the raw change name (no trimming / normalization)", () => {
    expect(buildMaterializeScope("  weird name ")).toEqual({
      changeNames: ["  weird name "],
    });
  });
});
